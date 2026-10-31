#!/bin/sh
echo --% >/dev/null;: ' | Out-Null
<#'
# SPDX-License-Identifier: Apache-2.0
#
# search-hole SessionStart preflight (ADR-0002 point 4, ADR-0014 point 5).
# The sh/PowerShell polyglot trick (first three lines, and the closing "exit" / "#" + ">" pair)
# is adapted from nightshift's hooks/dispatch/claude-hardhat.ps1 (MIT licence,
# Copyright the nightshift authors).
#
# Hook form: . "${CLAUDE_PLUGIN_ROOT}/hooks/preflight.ps1"   (shell form, onFailure: continue)
#   - sh, bash, Git Bash: this sh body runs and the PowerShell part below is never reached.
#   - PowerShell: the three lines above hide this sh body in a block comment, and the
#     PowerShell tail at the bottom hands over to preflight-windows.ps1.
#
# It needs no network and uses only shell builtins (the PATH may be nearly empty, and the point is
# to cope with a missing node). Prints {"systemMessage": "..."} only when Node.js is missing or
# older than 22.19; otherwise prints nothing. It always exits 0, so it can never block a session.
# Keep the message free of double quotes and backslashes except the JSON arrow escape (backslash, u, 2192).

search_hole_preflight() {
  msg=''
  if ! command -v node >/dev/null 2>&1; then
    msg='search-hole needs Node.js 22.19 or newer, but node was not found on PATH. Install it (macOS: brew install node; Windows: winget install OpenJS.NodeJS.LTS; Linux: your package manager or https://nodejs.org), then restart Claude Code or run /mcp \u2192 reconnect search-hole.'
  else
    v=$(node --version 2>/dev/null) || v=''
    v=${v#v}
    case $v in *.*) ;; *) return 0 ;; esac
    major=${v%%.*}
    rest=${v#*.}
    minor=${rest%%.*}
    case $major in '' | *[!0-9]*) return 0 ;; esac
    case $minor in '' | *[!0-9]*) return 0 ;; esac
    if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 19 ]; }; then
      msg="search-hole needs Node.js 22.19 or newer, but found v$v. Upgrade Node.js (https://nodejs.org), then restart Claude Code or run /mcp \\u2192 reconnect search-hole."
    fi
  fi
  if [ -n "$msg" ]; then
    printf '{"systemMessage":"%s"}\n' "$msg"
  fi
}

search_hole_preflight
exit 0
#>
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$env:CLAUDE_PLUGIN_ROOT\hooks\preflight-windows.ps1"
exit 0
