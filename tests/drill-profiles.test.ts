/**
 * The one piece of the live-dogfood drill worth testing without spending an
 * agent's tokens: selecting a real profile record into a throwaway registry.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { selectProfileRegistry } from '../drill/profiles.ts'

const registry = {
  schemaVersion: 1,
  default: null,
  hostDefaults: { terminal: 'claude' },
  profiles: {
    claude: { registryId: 'claude', binary: '/usr/local/bin/claude-agent-acp', args: [], env: {}, installedAt: 'x' },
    codex: {
      registryId: 'codex',
      binary: '/usr/local/bin/codex-acp',
      args: [],
      env: {},
      installedAt: 'y',
      installedVia: 'brew',
      codexPath: '/usr/local/bin/codex',
    },
  },
}

describe('selectProfileRegistry', () => {
  it('copies the named record verbatim and pins it as the default', () => {
    const selected = selectProfileRegistry(registry, 'codex')
    assert.equal(selected.default, 'codex', 'the throwaway registry cannot select anything else')
    assert.deepEqual(Object.keys(selected.profiles), ['codex'])
    // Verbatim matters: consult carries launch details this drill has no
    // business interpreting, and dropping one would test a differently
    // configured agent than the user has.
    assert.deepEqual(selected.profiles.codex, registry.profiles.codex)
    assert.equal(selected.profiles.codex?.codexPath, '/usr/local/bin/codex')
  })

  it('detaches the copy from the source record', () => {
    const selected = selectProfileRegistry(registry, 'codex')
    ;(selected.profiles.codex as Record<string, unknown>).binary = '/tmp/tampered'
    assert.equal(registry.profiles.codex.binary, '/usr/local/bin/codex-acp')
  })

  it('drops the user\'s host defaults rather than carrying them into the drill', () => {
    assert.deepEqual(selectProfileRegistry(registry, 'codex').hostDefaults, {})
  })

  it('names the installed profiles when the requested one is absent', () => {
    assert.throws(() => selectProfileRegistry(registry, 'gpt-9'), (error: unknown) =>
      error instanceof Error && /no consult profile named "gpt-9"/.test(error.message) && /claude, codex/.test(error.message))
  })

  it('reports an empty registry as empty rather than as a missing name', () => {
    assert.throws(() => selectProfileRegistry({ schemaVersion: 1, profiles: {} }, 'codex'), /\(none\)/)
  })

  it('refuses a registry schema it does not understand', () => {
    assert.throws(() => selectProfileRegistry({ schemaVersion: 2, profiles: {} }, 'codex'), /schemaVersion 1, found 2/)
  })

  it('refuses a document that is not a registry', () => {
    assert.throws(() => selectProfileRegistry({ schemaVersion: 1 }, 'codex'), /no profiles object/)
    assert.throws(() => selectProfileRegistry({ schemaVersion: 1, profiles: [] }, 'codex'), /no profiles object/)
    assert.throws(() => selectProfileRegistry({ schemaVersion: 1, profiles: { codex: 'nope' } }, 'codex'), /is not a record/)
  })
})
