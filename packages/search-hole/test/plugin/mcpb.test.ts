// SPDX-License-Identifier: Apache-2.0
// The Claude Desktop extension manifest (ADR-0021 point 9, ADR-0002, ADR-0007), checked with the
// mcpb toolchain's own validator and the exact substitution Desktop runs (getMcpConfigForManifest).
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${...} strings are mcpb placeholders, not templates
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMcpConfigForManifest, type McpbManifestAny, validateManifest } from '@anthropic-ai/mcpb'
import { describe, expect, it } from 'vitest'
import { TOOL_ORDER } from '../../src/gateway/tools.ts'
import { resolveKey } from '../../src/shared/keys/resolve.ts'

const DIR = join(import.meta.dirname, '..', '..', '..', '..', 'distribution', 'claude-desktop')
const FILE = join(DIR, 'manifest.json')
const manifest = JSON.parse(readFileSync(FILE, 'utf8')) as McpbManifestAny & {
  version: string
  tools: Array<{ name: string }>
  user_config: Record<string, { sensitive?: boolean; required?: boolean }>
}
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as {
  version: string
}

const config = (userConfig: Record<string, string>) =>
  getMcpConfigForManifest({
    manifest,
    extensionPath: '/ext/search-hole',
    systemDirs: {},
    userConfig,
    pathSeparator: '/',
  })

describe('Claude Desktop extension manifest', () => {
  it('validates with the mcpb toolchain and tracks the package version', () => {
    expect(validateManifest(FILE)).toBe(true)
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.manifest_version).toBe('0.3')
  })

  it("runs the bundled gateway on Desktop's own Node for the claude-desktop profile", async () => {
    const c = await config({})
    expect(c?.command).toBe('node')
    expect(c?.args).toEqual(['/ext/search-hole/dist/searchhole.mjs', 'mcp', '--host', 'claude-desktop'])
  })

  it('keys are optional and sensitive; an unset key stays a placeholder that counts as unset', async () => {
    for (const k of ['tavily_api_key', 'brave_api_key']) {
      expect(manifest.user_config[k]).toMatchObject({ sensitive: true, required: false })
    }
    const unset = await config({})
    expect(unset?.env?.SEARCHHOLE_TAVILY_API_KEY).toBe('${user_config.tavily_api_key}')
    const resolved = await resolveKey('tavily', { env: unset?.env ?? {} })
    expect(resolved).toMatchObject({ key: null, source: 'missing' })
    const set = await config({ tavily_api_key: 'tvly-dev-0123456789abcdef0123' })
    expect(set?.env?.SEARCHHOLE_TAVILY_API_KEY).toBe('tvly-dev-0123456789abcdef0123')
  })

  it('lists exactly the four model-visible tools', () => {
    const modelTools = TOOL_ORDER.filter((t) => t !== 'hook' && t !== 'apply_rule')
    expect(manifest.tools.map((t) => t.name)).toEqual(modelTools)
  })
})
