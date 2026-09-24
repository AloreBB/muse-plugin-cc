---
description: Check whether the local Muse CLI is ready
allowed-tools: Bash(node:*), Bash(muse:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-companion.mjs" setup --json $ARGUMENTS
```

Output rules:
- Present the final setup output to the user.
- If Muse is installed but not authenticated, preserve the guidance to run `muse login` or `muse auth set`.
