# SPDX-License-Identifier: Apache-2.0
#
# PowerShell half of the search-hole SessionStart preflight (see preflight.ps1).
# Prints {"systemMessage": "..."} only when Node.js is missing or older than 22.19.
# Always exits 0 so it can never block a session.
$ErrorActionPreference = 'SilentlyContinue'
$msg = $null
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  $msg = 'search-hole needs Node.js 22.19 or newer, but node was not found on PATH. Install it (Windows: winget install OpenJS.NodeJS.LTS or https://nodejs.org), then restart Claude Code or run /mcp \u2192 reconnect search-hole.'
} else {
  $v = (& node --version 2>$null) | Select-Object -First 1
  if ($v -match '^v?(\d+)\.(\d+)') {
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 19)) {
      $msg = 'search-hole needs Node.js 22.19 or newer, but found v' + $major + '.' + $minor + '. Upgrade Node.js (https://nodejs.org), then restart Claude Code or run /mcp \u2192 reconnect search-hole.'
    }
  }
}
if ($msg) {
  Write-Output ('{"systemMessage":"' + $msg + '"}')
}
exit 0
