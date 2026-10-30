---
name: suggestions
description: 'List rules the assistant suggested that wait for your decision'
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools:
  - 'Bash(SEARCHHOLE_SKILL=1 node "${CLAUDE_PLUGIN_ROOT}/dist/searchhole.mjs" *)'
---

!`SEARCHHOLE_SKILL=1 node "${CLAUDE_PLUGIN_ROOT}/dist/searchhole.mjs" suggestions $ARGUMENTS`

The text above is the output of a search-hole command that the user just ran. Show it to the user exactly as printed, verbatim, in a code block, and stop there. Do not run any other command, do not edit any file, do not call any tool, and do not add commentary.
