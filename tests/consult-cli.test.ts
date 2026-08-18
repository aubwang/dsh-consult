/**
 * Unit coverage for the consult CLI adapter: environment injection, the semver
 * preflight gate, envelope parsing and projection, exit-code mapping, argv
 * construction, and output bounding. No process is spawned here — see
 * `provider.test.ts` for the spawning path.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  boundLines,
  boundText,
  buildConsultEnv,
  delegateArgs,
  gateConsultVersion,
  mapExit,
  parseDoctorReport,
  parseJobCollection,
  parseJobEnvelope,
  projectJob,
  projectResult,
  reviewArgs,
  type ConsultRun,
} from '../src/consult-cli.ts'
import { DelegationError } from '../src/seam.ts'

const run = (overrides: Partial<ConsultRun> = {}): ConsultRun => ({
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  truncated: false,
  ...overrides,
})

const envelopeJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 1,
  job: {
    id: 'job-7',
    label: 'audit',
    kind: 'delegate',
    status: 'completed',
    profile: 'claude',
    authority: { schemaVersion: 1, mode: 'write', confinement: 'confined' },
    mode: 'write',
    submittedAt: '2026-08-18T00:00:00.000Z',
    completedAt: '2026-08-18T00:05:00.000Z',
    ...overrides,
  },
  outcome: { stopReason: 'end_turn', sessionId: 's', errorMessage: null, finalText: 'the answer' },
  artifacts: { touchedFiles: ['a.ts'], logPath: '/tmp/a.log', patchPath: null },
  lineage: { chainId: 'chain-1', parentJobId: null, childJobIds: [], delegationDepth: 0 },
})

describe('buildConsultEnv', () => {
  it('always stamps the managed host identity', () => {
    const env = buildConsultEnv({ hostSessionId: 'session-42' })
    assert.equal(env.CONSULT_HOST, 'dsh')
    assert.equal(env.CONSULT_HOST_SESSION_ID, 'session-42')
    assert.equal(env.CONSULT_DATA_DIR, undefined)
  })

  it('omits an absent or empty host session rather than sending a blank scope', () => {
    assert.equal(buildConsultEnv({}).CONSULT_HOST_SESSION_ID, undefined)
    assert.equal(buildConsultEnv({ hostSessionId: '' }).CONSULT_HOST_SESSION_ID, undefined)
  })

  it('forwards configured passthrough but never lets it spoof the host identity', () => {
    const env = buildConsultEnv({
      hostSessionId: 'real-session',
      dataDir: '/tmp/state',
      passthrough: { ANTHROPIC_API_KEY: 'secret', CONSULT_HOST: 'terminal', CONSULT_HOST_SESSION_ID: 'spoofed' },
    })
    assert.equal(env.ANTHROPIC_API_KEY, 'secret')
    assert.equal(env.CONSULT_HOST, 'dsh')
    assert.equal(env.CONSULT_HOST_SESSION_ID, 'real-session')
    assert.equal(env.CONSULT_DATA_DIR, '/tmp/state')
  })
})

describe('gateConsultVersion', () => {
  it('accepts the tested 1.x line', () => {
    assert.deepEqual(gateConsultVersion('1.0.0\n'), { ok: true, version: '1.0.0' })
    assert.deepEqual(gateConsultVersion('v1.4.2'), { ok: true, version: '1.4.2' })
  })

  it('rejects the stale 0.12.0 install with an actionable reason', () => {
    const gate = gateConsultVersion('0.12.0\n')
    assert.equal(gate.ok, false)
    assert.equal(gate.ok === false && gate.version, '0.12.0')
    assert.match(gate.ok === false ? gate.reason : '', />=1\.0\.0 <2\.0\.0/)
    assert.match(gate.ok === false ? gate.reason : '', /consultPath/)
  })

  it('rejects a future major', () => {
    assert.equal(gateConsultVersion('2.0.0').ok, false)
  })

  it('rejects output with no version in it', () => {
    const gate = gateConsultVersion('unknown subcommand: --version')
    assert.equal(gate.ok, false)
  })
})

describe('parseDoctorReport', () => {
  it('reads canDelegate and the selected profile', () => {
    const summary = parseDoctorReport(JSON.stringify({ canDelegate: true, profile: { ok: true, selectedProfile: 'codex' } }), '')
    assert.deepEqual(summary, { canDelegate: true, selectedProfile: 'codex' })
  })

  it('assembles a diagnosis from the failing sections', () => {
    const summary = parseDoctorReport(JSON.stringify({
      canDelegate: false,
      profile: { ok: false, error: 'No profile selected' },
      jobs: { ok: true },
      authority: { ok: false, error: 'preflight failed', remediation: 'run consult setup' },
    }), '')
    assert.equal(summary.canDelegate, false)
    assert.match(summary.diagnosis ?? '', /profile: No profile selected/)
    assert.match(summary.diagnosis ?? '', /authority: preflight failed — run consult setup/)
  })

  it('degrades to not-ready when doctor emits no JSON', () => {
    const summary = parseDoctorReport('not json', 'boom\n')
    assert.equal(summary.canDelegate, false)
    assert.match(summary.diagnosis ?? '', /boom/)
  })
})

describe('envelope parsing', () => {
  it('parses a schema-version-1 envelope and projects the job', () => {
    const job = projectJob(parseJobEnvelope(envelopeJson()))
    assert.deepEqual(job, {
      id: 'job-7',
      status: 'completed',
      label: 'audit',
      profile: 'claude',
      mode: 'write',
      kind: 'delegate',
      submittedAt: '2026-08-18T00:00:00.000Z',
      finishedAt: '2026-08-18T00:05:00.000Z',
    })
  })

  it('refuses an envelope from an unknown schema version', () => {
    const raw = JSON.stringify({ schemaVersion: 2, job: { id: 'x' }, outcome: {}, artifacts: {}, lineage: {} })
    assert.throws(() => parseJobEnvelope(raw), (error: unknown) =>
      error instanceof DelegationError && error.code === 'internal' && /schemaVersion 2/.test(error.message))
  })

  it('refuses output that is not JSON at all', () => {
    assert.throws(() => parseJobEnvelope('Usage: consult ...'), (error: unknown) =>
      error instanceof DelegationError && error.code === 'internal')
  })

  it('ignores unknown fields so the contract can evolve additively', () => {
    const raw = JSON.stringify({ ...JSON.parse(envelopeJson()), somethingNew: { deep: true } })
    assert.equal(projectJob(parseJobEnvelope(raw)).id, 'job-7')
  })

  it('projects an unrecognized provider status as unknown, keeping the raw value', () => {
    const job = projectJob(parseJobEnvelope(envelopeJson({ status: 'hibernating' })))
    assert.equal(job.status, 'unknown')
    assert.equal(job.rawStatus, 'hibernating')
  })

  it('parses a collection and a single envelope through the same door', () => {
    const collection = JSON.stringify({ schemaVersion: 1, jobs: [JSON.parse(envelopeJson()), JSON.parse(envelopeJson({ id: 'job-8' }))] })
    assert.deepEqual(parseJobCollection(collection).map(projectJob).map((job) => job.id), ['job-7', 'job-8'])
    assert.deepEqual(parseJobCollection(envelopeJson()).map(projectJob).map((job) => job.id), ['job-7'])
  })
})

describe('projectResult', () => {
  it('carries the bounded answer, artifacts, and lineage', () => {
    const result = projectResult(parseJobEnvelope(envelopeJson()), 1000)
    assert.equal(result.finalText, 'the answer')
    assert.equal(result.finalTextTruncated, false)
    assert.deepEqual(result.artifacts, { logPath: '/tmp/a.log', touchedFiles: ['a.ts'] })
    assert.deepEqual(result.lineage, { chainId: 'chain-1', delegationDepth: 0 })
  })

  it('bounds a long delegate answer and says so', () => {
    const raw = JSON.parse(envelopeJson()) as Record<string, unknown>
    raw.outcome = { finalText: 'x'.repeat(5000) }
    const result = projectResult(parseJobEnvelope(JSON.stringify(raw)), 100)
    assert.equal(result.finalTextTruncated, true)
    assert.ok(Buffer.byteLength(result.finalText ?? '', 'utf8') < 200)
    assert.match(result.finalText ?? '', /truncated: 4900 more bytes not shown/)
  })
})

describe('mapExit', () => {
  const cases: Array<[number, string]> = [
    [3, 'busy'],
    [4, 'timeout'],
    [5, 'not-final'],
    [6, 'delegate-failed'],
    [8, 'review-unsupported'],
    [1, 'internal'],
    [99, 'internal'],
  ]

  for (const [exitCode, code] of cases) {
    it(`maps exit ${exitCode} to the ${code} domain failure`, () => {
      const error = mapExit(run({ exitCode, stderr: 'because reasons' }), { command: 'result', jobId: 'job-7' })
      assert.ok(error instanceof DelegationError)
      assert.equal(error.code, code)
      assert.equal(error.jobId, 'job-7')
      assert.equal(error.detail, 'because reasons')
    })
  }

  it('treats exit 2 as an infrastructure failure, not a domain outcome', () => {
    const error = mapExit(run({ exitCode: 2, stderr: 'unknown job' }), { command: 'result', jobId: 'nope' })
    assert.ok(error instanceof Error)
    assert.equal(error instanceof DelegationError, false)
    assert.match(error?.message ?? '', /usage or configuration error \(exit 2\)/)
  })

  it('reports a signalled process as internal', () => {
    const error = mapExit(run({ exitCode: null, signal: 'SIGKILL' }), { command: 'wait' })
    assert.ok(error instanceof DelegationError)
    assert.equal(error.code, 'internal')
  })

  it('returns nothing for a clean exit', () => {
    assert.equal(mapExit(run(), { command: 'status' }), undefined)
  })
})

describe('argv construction', () => {
  const defaults = { mode: 'read-only' as const, sandbox: 'confined' as const, profile: undefined }

  it('always delegates in the background with the versioned envelope', () => {
    const args = delegateArgs({ prompt: 'do the thing' }, defaults)
    assert.deepEqual(args, ['delegate', '--background', '--json', '--read-only', '--sandbox', 'confined', '--', 'do the thing'])
  })

  it('carries every optional selector through', () => {
    const args = delegateArgs({
      prompt: 'p',
      profile: 'codex',
      mode: 'write',
      isolated: true,
      sandbox: 'inherit',
      after: ['job-1', 'job-2'],
      label: 'audit',
      model: 'sonnet',
      effort: 'high',
    }, defaults)
    assert.deepEqual(args, [
      'delegate', '--background', '--json', '--agent', 'codex', '--write', '--isolated',
      '--sandbox', 'inherit', '--model', 'sonnet', '--effort', 'high', '--label', 'audit',
      '--after', 'job-1', '--after', 'job-2', '--', 'p',
    ])
  })

  it('applies the configured defaults when the spec omits them', () => {
    const args = delegateArgs({ prompt: 'p' }, { mode: 'write', sandbox: 'inherit', profile: 'claude' })
    assert.ok(args.includes('--write'))
    assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'inherit'])
    assert.deepEqual(args.slice(args.indexOf('--agent'), args.indexOf('--agent') + 2), ['--agent', 'claude'])
  })

  it('refuses isolated delegation without write authority', () => {
    assert.throws(() => delegateArgs({ prompt: 'p', isolated: true }, defaults), (error: unknown) =>
      error instanceof DelegationError && error.code === 'unsupported')
  })

  it('builds a review against a base ref or a prior job, never both', () => {
    assert.deepEqual(reviewArgs({ base: 'main' }, { sandbox: 'confined', profile: undefined }),
      ['review', '--background', '--json', '--base', 'main', '--sandbox', 'confined'])
    assert.deepEqual(reviewArgs({ jobId: 'job-3', profile: 'codex' }, { sandbox: 'confined', profile: undefined }),
      ['review', '--background', '--json', '--agent', 'codex', '--job', 'job-3', '--sandbox', 'confined'])
    assert.throws(() => reviewArgs({ base: 'main', jobId: 'job-3' }, { sandbox: 'confined', profile: undefined }),
      (error: unknown) => error instanceof DelegationError && error.code === 'unsupported')
  })
})

describe('bounding', () => {
  it('leaves text within budget untouched', () => {
    assert.deepEqual(boundText('short', 100, 'head'), { text: 'short', truncated: false })
  })

  it('keeps the head for answers and the tail for logs', () => {
    const head = boundText('abcdefghij', 4, 'head')
    assert.ok(head.text.startsWith('abcd'))
    assert.equal(head.truncated, true)
    const tail = boundText('abcdefghij', 4, 'tail')
    assert.ok(tail.text.endsWith('ghij'))
    assert.equal(tail.truncated, true)
  })

  it('never splits a multi-byte code point', () => {
    const bounded = boundText('héllo wörld', 3, 'head')
    assert.doesNotThrow(() => Buffer.from(bounded.text, 'utf8'))
    assert.equal(bounded.text.includes('�'), false)
  })

  it('bounds by line count first, then by bytes', () => {
    const text = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n')
    const bounded = boundLines(text, 3, 10_000)
    assert.equal(bounded.truncated, true)
    assert.equal(bounded.text, 'line 7\nline 8\nline 9')
    assert.equal(boundLines(text, 100, 10_000).truncated, false)
  })
})
