# Changelog

## 0.1.0

- Initial port of `openai/codex-plugin-cc` (v1.0.6) from Codex to Muse.
- 8 slash commands: review, adversarial-review, rescue, transfer, status, result, cancel, setup.
- `muse:muse-rescue` thin-forwarder subagent plus `muse-cli-runtime` and `muse-result-handling` skills.
- Self-contained `muse-companion.mjs` runtime (Node builtins only): git review-target selection, prompt templates, foreground/background jobs with file-based state, Claude transcript handoff.
