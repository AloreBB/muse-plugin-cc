#!/usr/bin/env node
// muse-companion.mjs — runtime for the muse Claude Code plugin.
// Delegates reviews and tasks from Claude Code to the Muse CLI (`muse exec`).
// Only Node builtins are used. No dependencies.
//
// Env overrides (useful for tests):
//   MUSE_COMPANION_BIN         path to the muse binary (default: "muse")
//   MUSE_COMPANION_PROVIDER    extra `--provider <v>` flag on every muse call
//   MUSE_COMPANION_STATE_ROOT  override the state root directory
//   CLAUDE_PLUGIN_DATA         state root used by the Claude Code plugin host

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROMPTS_DIR = path.join(ROOT_DIR, "prompts");
const STATE_VERSION = 1;
const JOBS_DIR_NAME = "jobs";
const HANDOFFS_DIR_NAME = "handoffs";
const MAX_JOBS = 50;
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const STATUS_POLL_INTERVAL_MS = 500;
const MAX_INLINE_DIFF_BYTES = 120 * 1024;
const MAX_UNTRACKED_FILES = 20;
const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_TRANSFER_BYTES = 60 * 1024;
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const MUSE_BIN = process.env.MUSE_COMPANION_BIN || "muse";
const MUSE_PROVIDER = process.env.MUSE_COMPANION_PROVIDER || null;
// Headless runs have nobody to answer approval prompts: with Muse's default (on-request) the first
// shell call blocks forever. The sandbox still applies.
const MUSE_APPROVAL_MODE = process.env.MUSE_COMPANION_APPROVAL_MODE || "never";
const STATE_ROOT_OVERRIDE = process.env.MUSE_COMPANION_STATE_ROOT || null;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function nowIso() {
  return new Date().toISOString();
}

function fail(message) {
  process.stderr.write(`muse-companion: ${message}\n`);
  process.exit(1);
}

// ---- tiny arg parser (flags only; unknown --flags become focus text) ----
function parseArgs(argv, { valueOptions = [], booleanOptions = [] } = {}) {
  const values = new Set(valueOptions);
  const booleans = new Set(booleanOptions);
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--") || token === "--") {
      positionals.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (booleans.has(rawKey)) {
      options[rawKey] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    if (values.has(rawKey)) {
      const next = inlineValue ?? argv[i + 1];
      if (next === undefined) fail(`Missing value for --${rawKey}`);
      options[rawKey] = next;
      if (inlineValue === undefined) i += 1;
      continue;
    }
    positionals.push(token); // unknown flag: keep as focus text
  }
  return { options, positionals };
}

function splitRaw(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;
  for (const ch of raw) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

// ---- process helpers (no shell; argv arrays only) ----
function runCapture(cmd, args, { cwd, inputFile } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    shell: false,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (inputFile) return result; // placeholder guard (stdin via file not needed)
  return result;
}

function formatFailure(cmd, args, result) {
  const code = result.status ?? result.error?.message ?? "unknown";
  const stderr = (result.stderr || "").trim().split("\n").slice(-8).join("\n");
  return `${cmd} ${args.join(" ")} failed (exit ${code})${stderr ? `\n${stderr}` : ""}`;
}

// ---- state store (per-workspace dir, same idea as codex-plugin-cc) ----
function resolveWorkspaceRoot(cwd) {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, shell: false, encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim()) return git.stdout.trim();
  return path.resolve(cwd);
}

function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const pluginData = process.env[PLUGIN_DATA_ENV];
  const root = STATE_ROOT_OVERRIDE ?? (pluginData ? path.join(pluginData, "state") : path.join(os.tmpdir(), "muse-companion"));
  return path.join(root, `${slug}-${hash}`);
}

function statePaths(cwd) {
  const dir = resolveStateDir(cwd);
  return {
    dir,
    stateFile: path.join(dir, "state.json"),
    jobsDir: path.join(dir, JOBS_DIR_NAME),
    handoffsDir: path.join(dir, HANDOFFS_DIR_NAME),
  };
}

function defaultState() {
  return { version: STATE_VERSION, lastMuseSessionId: null, jobs: [] };
}

function loadState(cwd) {
  const { stateFile } = statePaths(cwd);
  if (!fs.existsSync(stateFile)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch {
    return defaultState();
  }
}

function saveState(cwd, state) {
  const { stateFile, jobsDir, handoffsDir } = statePaths(cwd);
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(handoffsDir, { recursive: true });
  const previousJobs = loadState(cwd).jobs;
  const byId = new Map();
  for (const job of [...previousJobs, ...(state.jobs ?? [])]) byId.set(job.id, job);
  const jobs = [...byId.values()]
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
  const removed = [...byId.keys()].filter((id) => !jobs.some((j) => j.id === id));
  for (const id of removed) {
    for (const suffix of [".json", ".spec.json", ".result.json", ".log"]) {
      const file = path.join(jobsDir, `${id}${suffix}`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  const next = { version: STATE_VERSION, lastMuseSessionId: state.lastMuseSessionId ?? null, jobs };
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function upsertJob(cwd, job) {
  const state = loadState(cwd);
  const jobs = state.jobs.filter((j) => j.id !== job.id);
  jobs.push({ ...job, updatedAt: nowIso() });
  saveState(cwd, { ...state, jobs });
}

function getJob(cwd, id) {
  return loadState(cwd).jobs.find((j) => j.id === id) ?? null;
}

function generateJobId() {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `muse-${ts}-${crypto.randomBytes(2).toString("hex")}`;
}

function appendLog(cwd, jobId, message) {
  const { jobsDir } = statePaths(cwd);
  const text = String(message ?? "").trim();
  if (!text) return;
  fs.appendFileSync(path.join(jobsDir, `${jobId}.log`), `[${nowIso()}] ${text}\n`, "utf8");
}

// ---- git review context ----
function git(cwd, args) {
  return spawnSync("git", args, { cwd, shell: false, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function ensureGitRepo(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.error?.code === "ENOENT") fail("git is not installed. Install Git and retry.");
  if (result.status !== 0) fail("This command must run inside a Git repository.");
  return result.stdout.trim();
}

function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const head = symbolic.stdout.trim();
    if (head.startsWith("refs/remotes/origin/")) return head.replace("refs/remotes/origin/", "");
  }
  for (const candidate of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) return candidate;
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0) {
      return `origin/${candidate}`;
    }
  }
  fail("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
  return null;
}

function isTextFile(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    return !buf.subarray(0, bytes).includes(0);
  } catch {
    return false;
  }
}

function collectReviewContext(cwd, { scope, base }) {
  const root = ensureGitRepo(cwd);
  let targetLabel;
  let diffStat = "";
  let diffBody = "";
  let untrackedSection = "";

  if (base) {
    const mergeBase = git(root, ["merge-base", "HEAD", base]);
    if (mergeBase.status !== 0) fail(`Cannot compare with base ref "${base}": ${mergeBase.stderr.trim()}`);
    const range = `${base}...HEAD`;
    targetLabel = `branch changes in ${range}`;
    diffStat = git(root, ["diff", "--stat", range]).stdout;
    diffBody = git(root, ["diff", range]).stdout;
  } else if (scope === "branch") {
    const defaultBranch = detectDefaultBranch(root);
    const range = `${defaultBranch}...HEAD`;
    targetLabel = `branch changes in ${range}`;
    diffStat = git(root, ["diff", "--stat", range]).stdout;
    diffBody = git(root, ["diff", range]).stdout;
  } else {
    // working-tree
    targetLabel = "uncommitted working-tree changes";
    const status = git(root, ["status", "--short", "--untracked-files=all"]).stdout;
    const staged = git(root, ["diff", "--stat", "--cached"]).stdout;
    const unstaged = git(root, ["diff", "--stat"]).stdout;
    diffStat = [status ? `status:\n${status}` : "", staged ? `staged:\n${staged}` : "", unstaged ? `unstaged:\n${unstaged}` : ""]
      .filter(Boolean)
      .join("\n\n");
    if (!status.trim() && !staged.trim() && !unstaged.trim()) {
      return { root, empty: true, targetLabel };
    }
    diffBody = `${git(root, ["diff", "--cached"]).stdout}\n${git(root, ["diff"]).stdout}`;
    const untracked = status
      .split("\n")
      .filter((line) => line.startsWith("??"))
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, MAX_UNTRACKED_FILES);
    const heads = [];
    for (const file of untracked) {
      const abs = path.join(root, file);
      try {
        if (!fs.statSync(abs).isFile() || !isTextFile(abs)) continue;
        const content = fs.readFileSync(abs, "utf8").slice(0, MAX_UNTRACKED_BYTES);
        heads.push(`--- untracked: ${file} ---\n${content}`);
      } catch {
        continue;
      }
    }
    if (heads.length > 0) untrackedSection = heads.join("\n\n");
  }

  if (!base && scope !== "working-tree" && !diffStat.trim() && !untrackedSection) {
    return { root, empty: true, targetLabel };
  }
  if (Buffer.byteLength(diffBody, "utf8") > MAX_INLINE_DIFF_BYTES) {
    diffBody = `${diffBody.slice(0, MAX_INLINE_DIFF_BYTES)}\n[... diff truncated ...]`;
  }
  return { root, empty: false, targetLabel, diffStat, diffBody, untrackedSection };
}

// ---- prompt templates ----
function loadPrompt(name) {
  const file = path.join(PROMPTS_DIR, `${name}.md`);
  return fs.readFileSync(file, "utf8");
}

function renderTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value ?? "");
  }
  return out;
}

// ---- muse invocation ----
function buildMuseArgs({ model, effort, sessionId, promptFile, workspace, readOnly }) {
  const args = ["exec", "--workspace", workspace, "--approval-mode", MUSE_APPROVAL_MODE];
  if (readOnly) args.push("--disable-write");
  if (MUSE_PROVIDER) args.push("--provider", MUSE_PROVIDER);
  if (model) args.push("--model", model);
  if (effort) args.push("--reasoning-effort", effort);
  if (sessionId) args.push("--session-id", sessionId);
  args.push("--prompt-file", promptFile);
  return args;
}

function checkMuseBinary() {
  const result = spawnSync(MUSE_BIN, ["--version"], { shell: false, encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    return { ok: false, error: `Muse CLI not found ("${MUSE_BIN}"). Install Muse and ensure it is on PATH.` };
  }
  if (result.status !== 0) {
    return { ok: false, error: `Muse CLI check failed: ${(result.stderr || result.error?.message || "").trim()}` };
  }
  return { ok: true, version: (result.stdout || "").trim().split("\n")[0] };
}

function runMuseForeground({ cwd, root, promptText, model, effort, sessionId, readOnly, jobId, kind }) {
  const { jobsDir } = statePaths(cwd);
  const promptFile = path.join(jobsDir, `${jobId}.prompt.md`);
  fs.writeFileSync(promptFile, promptText, "utf8");
  const args = buildMuseArgs({ model, effort, sessionId, promptFile, workspace: root, readOnly });
  appendLog(cwd, jobId, `Running: ${MUSE_BIN} ${args.join(" ")}`);
  const result = spawnSync(MUSE_BIN, args, { cwd: root, shell: false, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stderr.trim()) appendLog(cwd, jobId, `stderr:\n${stderr.trim()}`);
  if (result.error) {
    throw new Error(`Failed to start Muse: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(formatFailure(MUSE_BIN, args, result));
  }
  return stdout;
}

// ---- background job runner ----
function startBackgroundJob({ cwd, root, kind, summary, spec }) {
  const { jobsDir } = statePaths(cwd);
  fs.mkdirSync(jobsDir, { recursive: true });
  const id = generateJobId();
  const job = {
    id,
    kind,
    status: "running",
    phase: "queued",
    summary,
    pid: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    workspaceRoot: root,
  };
  fs.writeFileSync(path.join(jobsDir, `${id}.log`), `[${nowIso()}] Starting ${kind}: ${summary}\n`, "utf8");
  fs.writeFileSync(path.join(jobsDir, `${id}.spec.json`), JSON.stringify(spec, null, 2), "utf8");
  upsertJob(cwd, job);
  const child = spawn(process.execPath, [process.argv[1], "__run", id], {
    cwd: root,
    shell: false,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  child.unref();
  upsertJob(cwd, { ...job, pid: child.pid ?? null, phase: "running" });
  return getJob(cwd, id);
}

function runJobInternal(cwd, jobId) {
  const { jobsDir } = statePaths(cwd);
  const specFile = path.join(jobsDir, `${jobId}.spec.json`);
  const resultFile = path.join(jobsDir, `${jobId}.result.json`);
  let job = getJob(cwd, jobId);
  if (!job) fail(`Unknown job: ${jobId}`);
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
  } catch (err) {
    fail(`Cannot read job spec for ${jobId}: ${err.message}`);
  }
  upsertJob(cwd, { ...job, status: "running", phase: "running", pid: process.pid });
  appendLog(cwd, jobId, `Worker started (pid ${process.pid}).`);
  try {
    const startedAt = Date.now();
    const output = runMuseForeground({
      cwd,
      root: spec.workspaceRoot,
      promptText: spec.promptText,
      model: spec.model ?? null,
      effort: spec.effort ?? null,
      sessionId: spec.sessionId ?? null,
      readOnly: spec.readOnly === true,
      jobId,
      kind: job.kind,
    });
    const durationMs = Date.now() - startedAt;
    fs.writeFileSync(resultFile, JSON.stringify({ jobId, ok: true, output, durationMs }, null, 2), "utf8");
    appendLog(cwd, jobId, `Finished in ${Math.round(durationMs / 1000)}s.`);
    job = getJob(cwd, jobId);
    upsertJob(cwd, { ...job, status: "done", phase: "done", durationMs });
    if (spec.storeSession === true) {
      const state = loadState(cwd);
      const sessionId = spec.sessionId ?? null;
      if (sessionId) saveState(cwd, { ...state, lastMuseSessionId: sessionId });
    }
  } catch (err) {
    const message = err.message ?? String(err);
    fs.writeFileSync(resultFile, JSON.stringify({ jobId, ok: false, error: message }, null, 2), "utf8");
    appendLog(cwd, jobId, `Failed: ${message}`);
    job = getJob(cwd, jobId);
    upsertJob(cwd, { ...job, status: "failed", phase: "failed", error: message });
  }
}

// ---- render helpers ----
function formatDuration(ms) {
  if (ms == null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function jobAgeMs(job) {
  const start = Date.parse(job.createdAt ?? "");
  if (Number.isNaN(start)) return null;
  const end = job.status === "running" ? Date.now() : Date.parse(job.updatedAt ?? "");
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function renderStatusTable(jobs) {
  const header = "| job ID | kind | status | elapsed | summary | follow-up |";
  const divider = "|---|---|---|---|---|---|";
  const rows = jobs.map((job) => {
    const follow = job.status === "running" ? `\`/muse:status ${job.id}\`` : `\`/muse:result ${job.id}\``;
    const summary = String(job.summary ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 80);
    return `| ${job.id} | ${job.kind} | ${job.status} | ${formatDuration(jobAgeMs(job))} | ${summary} | ${follow} |`;
  });
  return [header, divider, ...rows].join("\n");
}

function renderJobDetail(cwd, job) {
  const { jobsDir } = statePaths(cwd);
  const lines = [
    `Job: ${job.id}`,
    `Kind: ${job.kind}`,
    `Status: ${job.status}${job.phase ? ` (${job.phase})` : ""}`,
    `Summary: ${job.summary ?? "-"}`,
    `Elapsed: ${formatDuration(jobAgeMs(job))}`,
  ];
  if (job.error) lines.push(`Error: ${job.error}`);
  const logFile = path.join(jobsDir, `${job.id}.log`);
  if (fs.existsSync(logFile)) {
    const tail = fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-15).join("\n");
    if (tail) lines.push("", "Recent log:", "```", tail, "```");
  }
  return lines.join("\n");
}

// ---- handlers ----
function handleSetup(cwd, rawArgv) {
  const { options } = parseArgs(rawArgv, { booleanOptions: ["json"] });
  const check = checkMuseBinary();
  const report = {
    ready: check.ok,
    binary: MUSE_BIN,
    ...(check.ok ? { version: check.version } : { error: check.error }),
    auth: "unknown — Meta provider auth is verified on the first real run (`muse login` or `muse auth set` if needed).",
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!check.ok) {
    console.log(["Muse is not ready.", "", check.error, "", "Install Muse, then rerun /muse:setup."].join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    [
      "Muse is ready.",
      "",
      `Binary: ${MUSE_BIN} (${check.version})`,
      "Auth: not checked here — if the first delegated task fails with an auth error, run `muse login` or `muse auth set`.",
      "",
      "Try: /muse:review --background",
    ].join("\n")
  );
}

function resolveReviewOptions(rawArgv) {
  const { options, positionals } = parseArgs(rawArgv, {
    valueOptions: ["base", "scope", "model", "effort"],
    booleanOptions: ["wait", "background"],
  });
  const scope = options.scope ?? "auto";
  if (!["auto", "working-tree", "branch"].includes(scope)) {
    fail(`Unsupported --scope "${scope}". Use auto, working-tree, or branch.`);
  }
  if (options.effort && !VALID_EFFORTS.has(options.effort)) {
    fail(`Unsupported --effort "${options.effort}". Use one of: ${[...VALID_EFFORTS].join(", ")}.`);
  }
  return { options, focusText: positionals.join(" ").trim(), scope };
}

function buildReviewPrompt({ templateName, ctx, focusText, model, effort }) {
  const template = loadPrompt(templateName);
  return renderTemplate(template, {
    TARGET_LABEL: ctx.targetLabel,
    DIFF_STAT: ctx.diffStat || "(empty)",
    DIFF_BODY: ctx.diffBody || "(empty)",
    UNTRACKED: ctx.untrackedSection || "(none)",
    USER_FOCUS: focusText || "(none — general review)",
    MODEL_NOTE: model ? `Requested model: ${model}.` : "",
    EFFORT_NOTE: effort ? `Requested reasoning effort: ${effort}.` : "",
  });
}

function handleReview(cwd, rawArgv, { templateName, kind, defaultSummary }) {
  const { options, focusText, scope } = resolveReviewOptions(rawArgv);
  if (kind === "review" && focusText) {
    fail("/muse:review takes no focus text. Use /muse:adversarial-review to steer the review.");
  }
  const ctx = collectReviewContext(cwd, { scope: scope === "auto" ? "auto" : scope, base: options.base ?? null });
  if (ctx.empty) {
    console.log(`Nothing to review (${ctx.targetLabel}).`);
    return;
  }
  const promptText = buildReviewPrompt({
    templateName,
    ctx,
    focusText,
    model: options.model ?? null,
    effort: options.effort ?? null,
  });
  const summary = `${defaultSummary}: ${ctx.targetLabel}`;
  if (options.background && !options.wait) {
    const job = startBackgroundJob({
      cwd,
      root: ctx.root,
      kind,
      summary,
      spec: {
        workspaceRoot: ctx.root,
        promptText,
        model: options.model ?? null,
        effort: options.effort ?? null,
        sessionId: null,
        readOnly: true,
        storeSession: false,
      },
    });
    console.log(`Muse ${kind} started in the background.\nJob: ${job.id}\nCheck /muse:status for progress.`);
    return;
  }
  const check = checkMuseBinary();
  if (!check.ok) fail(`${check.error} Run /muse:setup.`);
  const { jobsDir } = statePaths(cwd);
  fs.mkdirSync(jobsDir, { recursive: true });
  const id = generateJobId();
  const job = {
    id,
    kind,
    status: "running",
    phase: "running",
    summary,
    pid: process.pid,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    workspaceRoot: ctx.root,
  };
  fs.writeFileSync(path.join(jobsDir, `${id}.log`), `[${nowIso()}] Starting ${kind}: ${summary}\n`, "utf8");
  upsertJob(cwd, job);
  try {
    const startedAt = Date.now();
    const output = runMuseForeground({
      cwd,
      root: ctx.root,
      promptText,
      model: options.model ?? null,
      effort: options.effort ?? null,
      sessionId: null,
      readOnly: true,
      jobId: id,
      kind,
    });
    const durationMs = Date.now() - startedAt;
    fs.writeFileSync(
      path.join(jobsDir, `${id}.result.json`),
      JSON.stringify({ jobId: id, ok: true, output, durationMs }, null, 2),
      "utf8"
    );
    upsertJob(cwd, { ...getJob(cwd, id), status: "done", phase: "done", durationMs });
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  } catch (err) {
    const message = err.message ?? String(err);
    fs.writeFileSync(
      path.join(jobsDir, `${id}.result.json`),
      JSON.stringify({ jobId: id, ok: false, error: message }, null, 2),
      "utf8"
    );
    upsertJob(cwd, { ...getJob(cwd, id), status: "failed", phase: "failed", error: message });
    fail(message);
  }
}

function handleTask(cwd, rawArgv) {
  const { options, positionals } = parseArgs(rawArgv, {
    valueOptions: ["model", "effort"],
    booleanOptions: ["wait", "background", "resume", "fresh", "resume-last", "write", "read-only"],
  });
  const background = options.background && !options.wait;
  if (options.effort && !VALID_EFFORTS.has(options.effort)) {
    fail(`Unsupported --effort "${options.effort}". Use one of: ${[...VALID_EFFORTS].join(", ")}.`);
  }
  const taskText = positionals.join(" ").trim();
  if (!taskText) fail("No task text. Tell Muse what to investigate, solve, or continue.");
  const state = loadState(cwd);
  let sessionId = null;
  if (options.resume || options["resume-last"]) {
    if (!state.lastMuseSessionId) fail("No previous Muse session for this workspace. Retry without --resume.");
    sessionId = state.lastMuseSessionId;
  } else if (!options.fresh) {
    sessionId = null;
  }
  if (!sessionId) sessionId = crypto.randomUUID();
  const readOnly = options["read-only"] === true;
  const template = loadPrompt("task");
  const promptText = renderTemplate(template, {
    TASK_TEXT: taskText,
    MODE_NOTE: readOnly
      ? "Read-only mode: investigate and report. Do NOT modify files."
      : "Write-capable mode: you may edit files in the workspace to complete the task.",
  });
  const root = ensureGitRepo(cwd);
  const summary = taskText.replace(/\s+/g, " ").slice(0, 80);
  const spec = {
    workspaceRoot: root,
    promptText,
    model: options.model ?? null,
    effort: options.effort ?? null,
    sessionId,
    readOnly,
    storeSession: true,
  };
  if (background) {
    const job = startBackgroundJob({ cwd, root, kind: "task", summary, spec });
    console.log(`Muse task started in the background.\nJob: ${job.id}\nCheck /muse:status for progress.`);
    return;
  }
  const check = checkMuseBinary();
  if (!check.ok) fail(`${check.error} Run /muse:setup.`);
  const { jobsDir } = statePaths(cwd);
  fs.mkdirSync(jobsDir, { recursive: true });
  const id = generateJobId();
  fs.writeFileSync(path.join(jobsDir, `${id}.log`), `[${nowIso()}] Starting task: ${summary}\n`, "utf8");
  upsertJob(cwd, {
    id,
    kind: "task",
    status: "running",
    phase: "running",
    summary,
    pid: process.pid,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    workspaceRoot: root,
  });
  try {
    const startedAt = Date.now();
    const output = runMuseForeground({ cwd, root, promptText, model: spec.model, effort: spec.effort, sessionId, readOnly, jobId: id, kind: "task" });
    const durationMs = Date.now() - startedAt;
    fs.writeFileSync(
      path.join(jobsDir, `${id}.result.json`),
      JSON.stringify({ jobId: id, ok: true, output, durationMs, sessionId }, null, 2),
      "utf8"
    );
    upsertJob(cwd, { ...getJob(cwd, id), status: "done", phase: "done", durationMs });
    saveState(cwd, { ...loadState(cwd), lastMuseSessionId: sessionId });
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  } catch (err) {
    const message = err.message ?? String(err);
    fs.writeFileSync(path.join(jobsDir, `${id}.result.json`), JSON.stringify({ jobId: id, ok: false, error: message }, null, 2), "utf8");
    upsertJob(cwd, { ...getJob(cwd, id), status: "failed", phase: "failed", error: message });
    fail(message);
  }
}

function handleTaskResumeCandidate(cwd) {
  const state = loadState(cwd);
  const available = Boolean(state.lastMuseSessionId);
  console.log(
    JSON.stringify(
      { available, ...(available ? { sessionId: state.lastMuseSessionId } : { hint: "No previous Muse task session in this workspace." }) },
      null,
      2
    )
  );
}

function resolveUserPath(cwd, value) {
  if (value === "~") return os.homedir();
  if (String(value).startsWith("~/")) return path.join(os.homedir(), String(value).slice(2));
  return path.isAbsolute(value) ? value : path.join(cwd, value);
}

function extractTranscriptText(jsonl, maxBytes) {
  const chunks = [];
  let total = 0;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const type = entry.type ?? entry.role ?? "";
    if (!/^(human|user|assistant|text)$/i.test(String(type))) continue;
    const content = entry.message?.content ?? entry.content ?? entry.text ?? "";
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((part) => (typeof part === "string" ? part : part.text ?? part.content ?? ""))
        .filter(Boolean)
        .join("\n");
    }
    text = String(text).trim();
    if (!text) continue;
    const labeled = type.toString().toLowerCase().startsWith("human") || type.toString().toLowerCase() === "user" ? `User: ${text}` : `Assistant: ${text}`;
    total += Buffer.byteLength(labeled, "utf8");
    if (total > maxBytes) {
      chunks.push("[... transcript truncated ...]");
      break;
    }
    chunks.push(labeled);
  }
  return chunks.join("\n\n");
}

function handleTransfer(cwd, rawArgv) {
  const { options } = parseArgs(rawArgv, { valueOptions: ["source"], booleanOptions: [] });
  const requested = options.source || process.env.MUSE_COMPANION_TRANSCRIPT_PATH;
  if (!requested) fail("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  const sourcePath = resolveUserPath(cwd, requested);
  if (path.extname(sourcePath) !== ".jsonl") fail(`Claude session source must be a JSONL file: ${sourcePath}`);
  let real;
  try {
    real = fs.realpathSync(sourcePath);
  } catch {
    fail(`Claude session file not found: ${sourcePath}`);
  }
  const allowedRoot = path.join(os.homedir(), ".claude", "projects");
  const relative = path.relative(allowedRoot, real);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`Only Claude sessions under ${allowedRoot} can be handed off: ${real}`);
  }
  const transcript = extractTranscriptText(fs.readFileSync(real, "utf8"), MAX_TRANSFER_BYTES);
  if (!transcript.trim()) fail("The Claude transcript has no readable user/assistant text to hand off.");
  const root = resolveWorkspaceRoot(cwd);
  const { handoffsDir } = statePaths(cwd);
  fs.mkdirSync(handoffsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const handoffFile = path.join(handoffsDir, `claude-handoff-${stamp}.md`);
  fs.writeFileSync(
    handoffFile,
    `# Claude session handoff\n\nSource: ${real}\nWorkspace: ${root}\n\n${transcript}\n`,
    "utf8"
  );
  console.log(
    [
      "Handoff file written:",
      handoffFile,
      "",
      "To continue this session in Muse, run:",
      `muse exec --workspace "${root}" --prompt-file "${handoffFile}"`,
      "",
      "Or resume it later from Claude with: /muse:rescue --resume <follow-up>",
    ].join("\n")
  );
}

function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

function waitForJob(cwd, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getJob(cwd, jobId);
    if (!job) fail(`Unknown job: ${jobId}`);
    if (job.status !== "running") return job;
    if (Date.now() >= deadline) return job;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STATUS_POLL_INTERVAL_MS);
  }
}

function handleStatus(cwd, rawArgv) {
  const { options, positionals } = parseArgs(rawArgv, {
    valueOptions: ["timeout-ms"],
    booleanOptions: ["wait", "all"],
  });
  const [jobId] = positionals.filter((t) => !t.startsWith("--"));
  if (jobId) {
    let job = getJob(cwd, jobId);
    if (!job) fail(`Unknown job: ${jobId}`);
    if (options.wait) {
      const timeoutMs = options["timeout-ms"] ? Number(options["timeout-ms"]) : DEFAULT_STATUS_WAIT_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) fail("Invalid --timeout-ms value.");
      job = waitForJob(cwd, jobId, timeoutMs);
    }
    console.log(renderJobDetail(cwd, job));
    return;
  }
  const state = loadState(cwd);
  const jobs = sortJobsNewestFirst(state.jobs);
  if (jobs.length === 0) {
    console.log("No Muse jobs for this repository yet. Start one with /muse:review or /muse:rescue.");
    return;
  }
  const visible = options.all ? jobs : jobs.slice(0, 10);
  console.log(renderStatusTable(visible));
}

function handleResult(cwd, rawArgv) {
  const { positionals } = parseArgs(rawArgv, {});
  const [jobId] = positionals.filter((t) => !t.startsWith("--"));
  const { jobsDir } = statePaths(cwd);
  let id = jobId;
  if (!id) {
    const done = sortJobsNewestFirst(loadState(cwd).jobs).find((j) => j.status !== "running");
    if (!done) fail("No finished Muse job yet. Pass a job id or check /muse:status.");
    id = done.id;
  }
  const job = getJob(cwd, id);
  if (!job) fail(`Unknown job: ${id}`);
  if (job.status === "running") {
    console.log(`Job ${id} is still running. Check /muse:status ${id} for progress.`);
    return;
  }
  const resultFile = path.join(jobsDir, `${id}.result.json`);
  if (!fs.existsSync(resultFile)) fail(`No stored result for job ${id}.`);
  const stored = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  console.log(`Job: ${id} (${job.status}, ${formatDuration(jobAgeMs(job))})`);
  console.log("");
  if (stored.ok) {
    const output = String(stored.output ?? "").trim();
    console.log(output || "(empty output)");
  } else {
    console.log(`Error: ${stored.error ?? "unknown"}`);
  }
}

function killPidTree(pid) {
  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function handleCancel(cwd, rawArgv) {
  const { positionals } = parseArgs(rawArgv, {});
  const [jobId] = positionals.filter((t) => !t.startsWith("--"));
  if (!jobId) fail("Pass a job id: /muse:cancel <job-id>.");
  const job = getJob(cwd, jobId);
  if (!job) fail(`Unknown job: ${jobId}`);
  if (job.status !== "running") {
    console.log(`Job ${jobId} is already ${job.status}. Nothing to cancel.`);
    return;
  }
  let stopped = false;
  if (job.pid) {
    stopped = killPidTree(job.pid);
    const deadline = Date.now() + 5000;
    while (job.pid && pidAlive(job.pid) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    if (job.pid && pidAlive(job.pid)) {
      try {
        process.kill(-job.pid, "SIGKILL");
      } catch {
        try {
          process.kill(job.pid, "SIGKILL");
        } catch {
          stopped = false;
        }
      }
    }
  }
  upsertJob(cwd, { ...getJob(cwd, jobId), status: "cancelled", phase: "cancelled", error: "Cancelled by user." });
  appendLog(cwd, jobId, "Cancelled by user.");
  console.log(stopped ? `Job ${jobId} cancelled.` : `Job ${jobId} marked cancelled (worker process already gone).`);
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/muse-companion.mjs setup [--json]",
      "  node scripts/muse-companion.mjs review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--effort <level>]",
      "  node scripts/muse-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--effort <level>] [focus ...]",
      "  node scripts/muse-companion.mjs task [--wait|--background] [--resume|--fresh] [--model <id>] [--effort <level>] [--read-only] <task text>",
      "  node scripts/muse-companion.mjs task-resume-candidate --json",
      "  node scripts/muse-companion.mjs transfer [--source <claude-jsonl>]",
      "  node scripts/muse-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all]",
      "  node scripts/muse-companion.mjs result [job-id]",
      "  node scripts/muse-companion.mjs cancel <job-id>",
    ].join("\n")
  );
}

function main() {
  const [, , command, ...rawRest] = process.argv;
  // Slash commands invoke us as `companion <cmd> "$ARGUMENTS"`, i.e. a single
  // raw string. Split it the same way a shell would. Multi-token argv (built
  // programmatically by the rescue subagent) passes through untouched.
  const rest = rawRest.length === 1 && command !== "__run" ? splitRaw(rawRest[0]) : rawRest;
  const cwd = process.cwd();
  switch (command) {
    case "setup":
      handleSetup(cwd, rest);
      break;
    case "review":
      handleReview(cwd, rest, { templateName: "review", kind: "review", defaultSummary: "Muse review" });
      break;
    case "adversarial-review":
      handleReview(cwd, rest, { templateName: "adversarial-review", kind: "adversarial-review", defaultSummary: "Muse adversarial review" });
      break;
    case "task":
      handleTask(cwd, rest);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(cwd);
      break;
    case "transfer":
      handleTransfer(cwd, rest);
      break;
    case "status":
      handleStatus(cwd, rest);
      break;
    case "result":
      handleResult(cwd, rest);
      break;
    case "cancel":
      handleCancel(cwd, rest);
      break;
    case "__run":
      runJobInternal(cwd, rest[0]);
      break;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

main();

