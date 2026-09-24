---
description: Cancel an active background Muse job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-companion.mjs" cancel "$ARGUMENTS"`
