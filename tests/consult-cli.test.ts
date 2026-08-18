/**
 * Unit coverage for the consult CLI adapter: environment injection, the semver
 * preflight gate, envelope parsing and projection, exit-code mapping, argv
 * construction, and output bounding. No process is spawned here — see
 * `provider.test.ts` for the spawning path.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  boundJson,
  boundLines,
  boundText,
  buildConsultEnv,
  delegateArgs,
  eventsArgs,
  gateConsultVersion,
  mapExit,
  mapSteerExit,
  MAX_STEER_GUIDANCE_BYTES,
  parseDoctorReport,
  parseEventLine,
  parseEventsEnvelope,
  parseJobCollection,
  parseJobEnvelope,
  projectEvent,
  projectJob,
  projectResult,
  reviewArgs,
  steerArgs,
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

describe('event argv', () => {
  it('always asks for JSON and only sends --since when it means something', () => {
    assert.deepEqual(eventsArgs('job-7'), ['events', 'job-7', '--json'])
    assert.deepEqual(eventsArgs('job-7', { sinceSeq: 0 }), ['events', 'job-7', '--json'])
    assert.deepEqual(eventsArgs('job-7', { follow: true, sinceSeq: 4 }), ['events', 'job-7', '--json', '--follow', '--since', '4'])
  })
})

describe('projectEvent', () => {
  const report = (type: string, extra: Record<string, unknown> = {}) =>
    projectEvent({ kind: 'report', type, at: '2026-08-18T00:00:02.000Z', seq: 1, message: 'hi', ...extra }, 'job-7', 1000)

  it('wakes for the types that mean the delegation cannot progress', () => {
    assert.equal(report('blocked')?.urgency, 'wake')
    assert.equal(report('decision_needed')?.urgency, 'wake')
  })

  it('informs for the types that can wait for the next step', () => {
    assert.equal(report('discovery')?.urgency, 'info')
    assert.equal(report('progress')?.urgency, 'info')
  })

  it('carries seq, timing, message, and data through', () => {
    const event = report('discovery', { data: { file: 'a.ts' } })
    assert.deepEqual(event, {
      jobId: 'job-7',
      seq: 1,
      at: '2026-08-18T00:00:02.000Z',
      type: 'discovery',
      urgency: 'info',
      message: 'hi',
      data: { file: 'a.ts' },
    })
  })

  it('bounds a long delegate message', () => {
    const event = projectEvent({ kind: 'report', type: 'progress', at: 'x', seq: 1, message: 'z'.repeat(5000) }, 'job-7', 100)
    assert.ok(Buffer.byteLength(event?.message ?? '', 'utf8') < 200)
    assert.match(event?.message ?? '', /more bytes not shown/)
  })

  it('projects lifecycle transitions as informational, with no sequence', () => {
    const running = projectEvent({ kind: 'lifecycle', type: 'running', at: 'x' }, 'job-7', 1000)
    assert.deepEqual(running, { jobId: 'job-7', at: 'x', type: 'lifecycle', urgency: 'info', message: 'delegation job-7 running', lifecycle: { phase: 'running' } })
    const terminal = projectEvent({ kind: 'lifecycle', type: 'terminal', at: 'y', status: 'failed', errorMessage: 'ran out of context' }, 'job-7', 1000)
    assert.equal(terminal?.seq, undefined)
    assert.deepEqual(terminal?.lifecycle, { phase: 'terminal', status: 'failed', errorMessage: 'ran out of context' })
  })

  it('drops shapes it does not recognize rather than inventing an event', () => {
    assert.equal(projectEvent({ kind: 'report', type: 'gossip', at: 'x', seq: 1, message: 'hi' }, 'job-7', 1000), undefined)
    assert.equal(projectEvent({ kind: 'lifecycle', type: 'hibernating', at: 'x' }, 'job-7', 1000), undefined)
    assert.equal(projectEvent({ kind: 'something-new', type: 'blocked', at: 'x' }, 'job-7', 1000), undefined)
    assert.equal(projectEvent('not an object', 'job-7', 1000), undefined)
  })
})

describe('parseEventsEnvelope', () => {
  const envelope = (events: unknown[], overrides: Record<string, unknown> = {}) =>
    JSON.stringify({ schemaVersion: 1, jobId: 'job-7', events, ...overrides })

  it('projects every recognized event in emission order', () => {
    const events = parseEventsEnvelope(envelope([
      { kind: 'lifecycle', type: 'running', at: 'a' },
      { kind: 'report', type: 'blocked', at: 'b', seq: 1, message: 'stuck' },
      { kind: 'report', type: 'unheard-of', at: 'c', seq: 2, message: 'x' },
    ]), 1000)
    assert.deepEqual(events.map((event) => event.type), ['lifecycle', 'blocked'])
  })

  it('refuses an unknown events schema version', () => {
    assert.throws(() => parseEventsEnvelope(envelope([], { schemaVersion: 2 }), 1000), (error: unknown) =>
      error instanceof DelegationError && error.code === 'internal' && /events schemaVersion 2/.test(error.message))
  })

  it('refuses an envelope missing its job id or events array', () => {
    assert.throws(() => parseEventsEnvelope(JSON.stringify({ schemaVersion: 1, events: [] }), 1000), DelegationError)
    assert.throws(() => parseEventsEnvelope(JSON.stringify({ schemaVersion: 1, jobId: 'job-7' }), 1000), DelegationError)
  })
})

describe('parseEventLine', () => {
  const line = (event: unknown, overrides: Record<string, unknown> = {}) =>
    JSON.stringify({ schemaVersion: 1, jobId: 'job-7', event, ...overrides })

  it('unwraps one framed follow event', () => {
    const event = parseEventLine(line({ kind: 'report', type: 'blocked', at: 'a', seq: 2, message: 'stuck' }), 1000)
    assert.equal(event?.seq, 2)
    assert.equal(event?.urgency, 'wake')
  })

  it('drops a partial or malformed line instead of failing the stream', () => {
    // A follow stream is read while it is written, so half a line is routine.
    assert.equal(parseEventLine('{"schemaVersion":1,"jobId":"job-7","eve', 1000), undefined)
    assert.equal(parseEventLine('', 1000), undefined)
    assert.equal(parseEventLine('   ', 1000), undefined)
    assert.equal(parseEventLine('not json at all', 1000), undefined)
  })

  it('drops a line framed at an unknown version', () => {
    assert.equal(parseEventLine(line({ kind: 'report', type: 'blocked', at: 'a', seq: 1, message: 'x' }, { schemaVersion: 9 }), 1000), undefined)
  })
})

describe('boundJson', () => {
  it('passes a payload that fits through untouched', () => {
    assert.deepEqual(boundJson({ a: 1 }, 1000), { a: 1 })
  })

  it('replaces an oversized payload with a readable prefix rather than a pruned object', () => {
    const bounded = boundJson({ blob: 'x'.repeat(5000) }, 100)
    assert.equal(typeof bounded, 'string')
    assert.match(bounded as string, /more bytes not shown/)
  })

  it('survives a payload that cannot be encoded', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.equal(boundJson(cyclic, 1000), '[unencodable delegate data]')
  })
})

describe('steer argv and exit mapping', () => {
  it('sends the guidance through --message so a leading dash cannot be re-read as a flag', () => {
    assert.deepEqual(steerArgs('job-7', '--force the other approach'), ['steer', 'job-7', '--message', '--force the other approach'])
  })

  it('agrees with consult on the guidance bound', () => {
    assert.equal(MAX_STEER_GUIDANCE_BYTES, 16 * 1024)
  })

  it('reads exit 0 as delivered', () => {
    const outcome = mapSteerExit(run({ exitCode: 0, stdout: 'steered job-7\n' }), 'job-7')
    assert.deepEqual(outcome, { supported: true, accepted: true, detail: 'steered job-7' })
  })

  it('reads exit 1 as a delegation that can never be steered', () => {
    const outcome = mapSteerExit(run({ exitCode: 1, stderr: 'steer is not available for job job-7 (inline runner)' }), 'job-7')
    assert.equal('supported' in outcome && outcome.supported, false)
    assert.match((outcome as { reason: string }).reason, /inline runner/)
  })

  it('reads exit 3 as supported but not right now', () => {
    const outcome = mapSteerExit(run({ exitCode: 3, stderr: 'STEER_PENDING: a previous steer is still being delivered' }), 'job-7')
    assert.deepEqual(outcome, { supported: true, accepted: false, detail: 'STEER_PENDING: a previous steer is still being delivered' })
  })

  it('reads exit 5 as outside the running window, not as a hard refusal', () => {
    const outcome = mapSteerExit(run({ exitCode: 5, stderr: 'job already finalized; cannot steer (status=completed)' }), 'job-7')
    assert.equal('accepted' in outcome && outcome.accepted, false)
    assert.equal('supported' in outcome && outcome.supported, true)
  })

  it('keeps exit 2 an infrastructure failure, like every other command', () => {
    const outcome = mapSteerExit(run({ exitCode: 2, stderr: 'job not found' }), 'nope')
    assert.ok(outcome instanceof Error)
    assert.equal(outcome instanceof DelegationError, false)
  })

  it('falls back to a supplied reason when consult said nothing', () => {
    const outcome = mapSteerExit(run({ exitCode: 1 }), 'job-7')
    assert.match((outcome as { reason: string }).reason, /refused the guidance/)
  })
})

describe('steer events', () => {
  it('projects a steer echo as an informational event sharing the report sequence', () => {
    const event = projectEvent({ kind: 'steer', type: 'steer', at: 'a', seq: 2, message: 'skip the migration' }, 'job-7', 1000)
    assert.deepEqual(event, { jobId: 'job-7', seq: 2, at: 'a', type: 'steer', urgency: 'info', message: 'skip the migration' })
  })

  it('bounds the echoed guidance preview like any other delegate-visible text', () => {
    const event = projectEvent({ kind: 'steer', type: 'steer', at: 'a', seq: 1, message: 'z'.repeat(5000) }, 'job-7', 100)
    assert.ok(Buffer.byteLength(event?.message ?? '', 'utf8') < 200)
  })
})
