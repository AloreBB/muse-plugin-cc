# Muse plugin for Claude Code

Use Muse from inside Claude Code for code reviews or to delegate tasks to Muse.

Port of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc): same
command surface and architecture, but the worker is the Muse CLI (`muse exec`)
instead of the Codex CLI. No app-server, no extra services — the companion script
shells out to `muse exec` and tracks background jobs in local state files.

## What You Get

- `/muse:review` for a normal read-only Muse review
- `/muse:adversarial-review` for a steerable challenge review
- `/muse:rescue`, `/muse:transfer`, `/muse:status`, `/muse:result`, and `/muse:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **Muse CLI installed and on PATH** (this repo's host already ships it as `muse`).
  Run `/muse:setup` to verify. If the first delegated task fails with an auth
  error, run `muse login` or `muse auth set`.
- **Node.js 18.18 or later** (companion runtime only, no dependencies).

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add <your-fork-or-path>/muse-plugin-cc
```

Install the plugin:

```bash
/plugin install muse@muse-plugin-cc
```

Then run:

```bash
/muse:setup
```

One simple first run is:

```bash
/muse:review --background
/muse:status
/muse:result
```

## Usage

### `/muse:review`

Runs a normal Muse review on your current work (read-only, never edits).

```bash
/muse:review
/muse:review --base main
/muse:review --background
```

Supports `--base <ref>`, `--scope auto|working-tree|branch`, `--model <id>`,
`--effort <level>`, `--wait`, `--background`. Takes no focus text — use
`/muse:adversarial-review` to steer.

### `/muse:adversarial-review`

Steerable review that questions the implementation and design:

```bash
/muse:adversarial-review
/muse:adversarial-review --base main challenge whether this was the right caching and retry design
/muse:adversarial-review --background look for race conditions and question the chosen approach
```

Same target selection and flags as `/muse:review`, plus free focus text.

### `/muse:rescue`

Hands a task to Muse through the `muse:muse-rescue` subagent (write-capable by default):

```bash
/muse:rescue investigate why login fails on staging
/muse:rescue --background migrate the billing module to the new API
/muse:rescue --resume apply the top fix
/muse:rescue --read-only diagnose the flaky test without changing code
```

Flags: `--background|--wait`, `--resume|--fresh`, `--model <id>`,
`--effort none|minimal|low|medium|high|xhigh|max|ultra`, `--read-only`.

### `/muse:transfer`

Writes the current Claude transcript to a handoff file and prints the
`muse exec --prompt-file ...` command to continue it in Muse:

```bash
/muse:transfer --source ~/.claude/projects/<project>/<session>.jsonl
```

### `/muse:status`, `/muse:result`, `/muse:cancel`

```bash
/muse:status
/muse:status <job-id> --wait --timeout-ms 120000
/muse:result <job-id>
/muse:cancel <job-id>
```

## Layout

```text
.claude-plugin/marketplace.json
plugins/muse/
  .claude-plugin/plugin.json
  commands/      review, adversarial-review, rescue, transfer, status, result, cancel, setup
  agents/        muse-rescue.md (thin forwarder subagent)
  skills/        muse-cli-runtime, muse-result-handling
  prompts/       review, adversarial-review, task templates
  scripts/       muse-companion.mjs (self-contained Node runtime, no deps)
```

## Differences from codex-plugin-cc

- Worker is `muse exec --workspace <root> --prompt-file <file>` (plus `--model`,
  `--reasoning-effort`, `--session-id`); no Codex app-server or broker daemon.
- Background jobs are detached `node muse-companion.mjs __run <job-id>` workers
  tracked in `$CLAUDE_PLUGIN_DATA/state` (fallback: system temp dir).
- Session resume maps to `muse exec --session-id`; no thread import protocol.
- No stop-time review-gate hooks and no GPT-prompting skill (Codex-specific).
- `--effort` accepts Muse's full range including `max` and `ultra`.
