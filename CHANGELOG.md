# Changelog

## 0.1.1

- Pass `--approval-mode never` to `muse exec` (override with `MUSE_COMPANION_APPROVAL_MODE`). Headless runs had nobody to approve tool calls, so any task or review that ran a shell command hung forever.
- `--read-only` tasks and reviews pass `--disable-write`, instead of only asking in the prompt.
- Pass `--disable-sandbox` by default (opt back in with `MUSE_COMPANION_SANDBOX=on`): on hosts that restrict unprivileged user namespaces the sandbox broke every shell call, git included.

## 0.1.0

- Initial port of `openai/codex-plugin-cc` (v1.0.6) from Codex to Muse.
- 8 slash commands: review, adversarial-review, rescue, transfer, status, result, cancel, setup.
- `muse:muse-rescue` thin-forwarder subagent plus `muse-cli-runtime` and `muse-result-handling` skills.
- Self-contained `muse-companion.mjs` runtime (Node builtins only): git review-target selection, prompt templates, foreground/background jobs with file-based state, Claude transcript handoff.
