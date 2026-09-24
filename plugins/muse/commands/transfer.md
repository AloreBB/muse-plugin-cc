---
description: Transfer the current Claude Code session into a resumable Muse handoff
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the handoff file path and the `muse exec` command.
