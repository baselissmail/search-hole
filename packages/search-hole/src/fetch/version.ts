// SPDX-License-Identifier: Apache-2.0
/** The honest user agent (§12.4): product token, version and the repo URL. */
import pkg from '../../package.json' with { type: 'json' }

export const VERSION: string = pkg.version

/** robots.txt product token we match `User-agent:` groups against. */
export const ROBOTS_TOKEN = 'search-hole'

/** Builds `search-hole/<version> (+https://github.com/baselissmail/search-hole)`. */
export function userAgent(version: string = VERSION): string {
  return `${ROBOTS_TOKEN}/${version} (+https://github.com/baselissmail/search-hole)`
}

export const USER_AGENT = userAgent()
