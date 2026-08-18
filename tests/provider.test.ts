/**
 * Integration coverage for the consult provider against a REAL Cordis context,
 * the REAL local subprocess service, and a real (fake-agent) `consult`
 * executable. Nothing here stubs `spawn`: argv, environment, stream collection,
 * exit codes, and process lifetime are exercised end to end, so a regression in
 * how the provider talks to the seam shows up here rather than in production.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ConsultDelegation, type Config } from '../src/provider.ts'
import { DelegationError, type DelegationEvent } from '../src/seam.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-consult.mjs', import.meta.url))

/** One invocation the fake consult recorded. */
interface Recorded {
  argv: string[]
  env: Record<string, string>
  cwd: string
}

interface Harness {
  ctx: Context
  delegation: ConsultDelegation
  /** Every consult invocation performed so far, in order. */
  invocations(): Recorded[]
}

const teardown: Array<() => Promise<void>> = []

async function setup(scenario: Record<string, string> = {}, config: Partial<Config> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-consult-test-'))
  const state = join(dir, 'state.json')
  const record = join(dir, 'record.jsonl')
  writeFileSync(record, '')
  const ctx = new Context()
  const subprocess = await ctx.plugin(LocalSubprocessRuntime)
  const provider = await ctx.plugin(ConsultDelegation, {
    consultPath: process.execPath,
    consultArgs: [FIXTURE],
    cwd: dir,
    graceMs: 500,
    env: {
      FAKE_CONSULT_STATE: state,
      FAKE_CONSULT_RECORD: record,
      // A credential-shaped name the subprocess service's ambient scrub drops:
      // seeing it in the child proves configured passthrough is explicit.
      FAKE_PASSTHROUGH_TOKEN: 'forwarded',
      ...scenario,
    },
    ...config,
  })
  teardown.push(async () => {
    await provider.dispose()
    await subprocess.dispose()
  })
  return {
    ctx,
    delegation: ctx.delegation as ConsultDelegation,
    invocations: () => readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Recorded),
  }
}

after(async () => {
  for (const dispose of teardown) await dispose()
})

/** Invocations of one subcommand. */
const of = (harness: Harness, command: string): Recorded[] =>
  harness.invocations().filter((entry) => entry.argv[0] === command)

describe('preflight', () => {
  it('accepts a 1.x consult and reports the profile roster', async () => {
    const harness = await setup()
    const capabilities = await harness.delegation.capabilities()
    assert.equal(capabilities.ready, true)
    assert.equal(capabilities.version, '1.0.0')
    assert.deepEqual([...capabilities.profiles], ['claude', 'codex'])
    assert.equal(capabilities.defaultProfile, 'claude')
    assert.equal(capabilities.canSteer, true, 'this consult build has the steer command')
    assert.equal(capabilities.canReport, true, 'this consult build has the events command')
  })

  it('rejects the stale 0.12.0 install without running doctor', async () => {
    const harness = await setup({ FAKE_CONSULT_VERSION: '0.12.0' })
    const capabilities = await harness.delegation.capabilities()
    assert.equal(capabilities.ready, false)
    assert.match(capabilities.diagnosis ?? '', />=1\.0\.0 <2\.0\.0/)
    assert.equal(of(harness, 'doctor').length, 0)
  })

  it('names a pre-1.0 install when consult does not even accept --version', async () => {
    const harness = await setup({ FAKE_CONSULT_VERSION_EXIT: '2' })
    const capabilities = await harness.delegation.capabilities()
    assert.equal(capabilities.ready, false)
    assert.match(capabilities.diagnosis ?? '', /most likely a pre-1\.0 install/)
    assert.equal(of(harness, 'doctor').length, 0)
  })

  it('turns a gate failure into a not-ready domain failure on every call', async () => {
    const harness = await setup({ FAKE_CONSULT_VERSION: '0.12.0' })
    await assert.rejects(harness.delegation.delegate({ prompt: 'p' }), (error: unknown) =>
      error instanceof DelegationError && error.code === 'not-ready' && /0\.12\.0/.test(error.detail ?? ''))
  })

  it('quotes doctor\'s own diagnosis when consult cannot delegate', async () => {
    const harness = await setup({ FAKE_CONSULT_DOCTOR_OK: '0' })
    const capabilities = await harness.delegation.capabilities()
    assert.equal(capabilities.ready, false)
    assert.match(capabilities.diagnosis ?? '', /profile: No profile selected/)
    assert.match(capabilities.diagnosis ?? '', /consult setup --install/)
  })

  it('memoizes a healthy preflight but re-probes after a failure', async () => {
    const harness = await setup({ FAKE_CONSULT_DOCTOR_FAIL_FIRST: '1' })
    assert.equal((await harness.delegation.capabilities()).ready, false)
    assert.equal((await harness.delegation.capabilities()).ready, true)
    assert.equal(of(harness, 'doctor').length, 2)
    await harness.delegation.capabilities()
    await harness.delegation.status()
    assert.equal(of(harness, 'doctor').length, 2, 'a healthy preflight is probed once')
  })
})

describe('environment injection', () => {
  it('stamps the managed host identity and forwards configured passthrough', async () => {
    const harness = await setup({}, { dataDir: '/tmp/consult-state' })
    await harness.delegation.delegate({ prompt: 'audit the API' }, { hostSessionId: 'session-abc' })
    const delegate = of(harness, 'delegate')[0]
    assert.ok(delegate !== undefined)
    assert.equal(delegate.env.CONSULT_HOST, 'dsh')
    assert.equal(delegate.env.CONSULT_HOST_SESSION_ID, 'session-abc')
    assert.equal(delegate.env.CONSULT_DATA_DIR, '/tmp/consult-state')
    assert.equal(delegate.env.FAKE_PASSTHROUGH_TOKEN, 'forwarded')
  })

  it('runs in the configured workspace', async () => {
    const harness = await setup()
    await harness.delegation.status()
    const status = of(harness, 'status')[0]
    assert.equal(status?.cwd, harness.delegation.config.cwd)
  })
})

describe('delegate and review', () => {
  it('always delegates in the background and projects the queued job', async () => {
    const harness = await setup({ FAKE_CONSULT_STATUS: 'queued' })
    const job = await harness.delegation.delegate({ prompt: 'p', label: 'audit', profile: 'codex' })
    assert.equal(job.status, 'queued')
    assert.equal(job.label, 'audit')
    assert.equal(job.profile, 'codex')
    assert.ok(of(harness, 'delegate')[0]?.argv.includes('--background'))
  })

  it('refuses an empty prompt before spawning anything', async () => {
    const harness = await setup()
    await assert.rejects(harness.delegation.delegate({ prompt: '   ' }), (error: unknown) =>
      error instanceof DelegationError && error.code === 'unsupported')
    assert.equal(of(harness, 'delegate').length, 0)
  })

  it('maps a profile without native review support to review-unsupported', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_REVIEW: '8' })
    await assert.rejects(harness.delegation.review({ base: 'main' }), (error: unknown) =>
      error instanceof DelegationError && error.code === 'review-unsupported')
  })
})

describe('exit-code mapping through a real spawn', () => {
  it('retries contention exactly once and then succeeds', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_DELEGATE: '3', FAKE_CONSULT_TRANSIENT_DELEGATE: '1' })
    const job = await harness.delegation.delegate({ prompt: 'p' })
    assert.equal(job.id, 'job-1')
    assert.equal(of(harness, 'delegate').length, 2, 'one retry, not a loop')
  })

  it('reports persistent contention as busy after exactly two attempts', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_DELEGATE: '3' })
    await assert.rejects(harness.delegation.delegate({ prompt: 'p' }), (error: unknown) =>
      error instanceof DelegationError && error.code === 'busy')
    assert.equal(of(harness, 'delegate').length, 2)
  })

  it('reports a result requested before finalization as not-final', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_RESULT: '5' })
    await assert.rejects(harness.delegation.result('job-1'), (error: unknown) =>
      error instanceof DelegationError && error.code === 'not-final')
  })

  it('reports a failed delegated turn as delegate-failed', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_DELEGATE: '6' })
    await assert.rejects(harness.delegation.delegate({ prompt: 'p' }), (error: unknown) =>
      error instanceof DelegationError && error.code === 'delegate-failed')
  })

  it('lets a usage error out as an infrastructure failure', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_STATUS: '2' })
    await assert.rejects(harness.delegation.status('nope'), (error: unknown) =>
      error instanceof Error && !(error instanceof DelegationError) && /exit 2/.test(error.message))
  })

  it('refuses output that is not a version-1 envelope', async () => {
    const harness = await setup({ FAKE_CONSULT_BAD_JSON: '1' })
    await assert.rejects(harness.delegation.delegate({ prompt: 'p' }), (error: unknown) =>
      error instanceof DelegationError && error.code === 'internal')
  })
})

describe('wait', () => {
  it('returns terminal results for every id in submission order', async () => {
    const harness = await setup()
    const results = await harness.delegation.wait(['job-1', 'job-2'], 10_000)
    assert.deepEqual(results.map((result) => result.id), ['job-1', 'job-2'])
    assert.equal(results[0]?.finalText, 'the delegate answer')
    const wait = of(harness, 'wait')[0]
    assert.ok(wait?.argv.includes('--keep-running'), 'an interrupted wait must not cancel the delegation')
  })

  it('reports consult\'s own follow deadline as timeout', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_WAIT: '4' })
    await assert.rejects(harness.delegation.wait(['job-1'], 10_000), (error: unknown) =>
      error instanceof DelegationError && error.code === 'timeout')
  })

  it('enforces the caller\'s own bound on a slow wait', async () => {
    const harness = await setup({ FAKE_CONSULT_DELAY_MS: '5000' })
    const started = Date.now()
    await assert.rejects(harness.delegation.wait(['job-1'], 300), (error: unknown) =>
      error instanceof DelegationError && error.code === 'timeout')
    assert.ok(Date.now() - started < 4_000, 'the bound must not wait for consult to finish')
  })

  it('does nothing for an empty id list', async () => {
    const harness = await setup()
    assert.deepEqual(await harness.delegation.wait([], 1_000), [])
    assert.equal(harness.invocations().length, 0)
  })
})

describe('bounded model-facing output', () => {
  it('truncates a long delegate answer to the configured budget', async () => {
    const harness = await setup({ FAKE_CONSULT_FINAL_TEXT: 'y'.repeat(50_000) }, { maxTextBytes: 500 })
    const result = await harness.delegation.result('job-1')
    assert.equal(result.finalTextTruncated, true)
    assert.ok(Buffer.byteLength(result.finalText ?? '', 'utf8') < 700)
  })

  it('returns only the requested transcript tail', async () => {
    const harness = await setup({ FAKE_CONSULT_LOG_LINES: '200' })
    const text = await harness.delegation.logs('job-1', 5)
    assert.deepEqual(text.trim().split('\n'), ['line 196', 'line 197', 'line 198', 'line 199', 'line 200'])
  })

  it('bounds a transcript that exceeds the byte budget even within its line budget', async () => {
    const harness = await setup({ FAKE_CONSULT_LOG_LINES: '5000' }, { maxTextBytes: 400 })
    const text = await harness.delegation.logs('job-1', 5000)
    assert.ok(Buffer.byteLength(text, 'utf8') < 600)
    assert.match(text, /earlier bytes not shown/)
  })
})

describe('status, cancel, and the deferred capabilities', () => {
  it('lists jobs and inspects one', async () => {
    const harness = await setup()
    assert.deepEqual((await harness.delegation.status()).map((job) => job.id), ['job-1', 'job-2'])
    assert.deepEqual((await harness.delegation.status('job-9')).map((job) => job.id), ['job-9'])
  })

  it('cancels a job', async () => {
    const harness = await setup()
    await harness.delegation.cancel('job-1')
    assert.deepEqual(of(harness, 'cancel')[0]?.argv, ['cancel', 'job-1'])
  })

  it('exposes the global event bus', async () => {
    const harness = await setup()
    assert.equal(typeof harness.delegation.onEvent(() => {}), 'function')
  })
})

/** Poll a predicate on a short bounded budget. */
async function until<T>(probe: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = probe()
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition was not met within the budget')
}

describe('the events capability probe', () => {
  it('asks the events command for its own help, and nothing more', async () => {
    const harness = await setup()
    assert.equal((await harness.delegation.capabilities()).canReport, true)
    assert.deepEqual(of(harness, 'events').map((entry) => entry.argv), [['events', '--help']])
    assert.deepEqual(of(harness, 'steer').map((entry) => entry.argv), [['steer', '--help']])
  })

  it('reports canReport false for a consult with no events command', async () => {
    const harness = await setup({ FAKE_CONSULT_NO_EVENTS: '1' })
    const capabilities = await harness.delegation.capabilities()
    assert.equal(capabilities.canReport, false)
    assert.equal(capabilities.ready, true, 'delegation still works without upward reporting')
  })

  it('answers events() with a typed unsupported page and spawns no follow', async () => {
    const harness = await setup({ FAKE_CONSULT_NO_EVENTS: '1' })
    const page = await harness.delegation.events('job-1')
    assert.equal(page.supported, false)
    assert.match(page.reason ?? '', /no `events` command/)
    const received: DelegationEvent[] = []
    const unwatch = harness.delegation.watch('job-1', (event) => received.push(event))
    await new Promise((resolve) => setTimeout(resolve, 300))
    unwatch()
    assert.deepEqual(received, [])
    assert.deepEqual(of(harness, 'events').map((entry) => entry.argv), [['events', '--help']])
  })

  it('refuses to read events when the binary itself is unusable', async () => {
    const harness = await setup({ FAKE_CONSULT_VERSION: '0.12.0' })
    await assert.rejects(harness.delegation.events('job-1'), (error: unknown) =>
      error instanceof DelegationError && error.code === 'not-ready')
  })

  it('still reads events when consult cannot start NEW delegations', async () => {
    // Observation must not be gated on the ability to delegate: a supervisor
    // whose profile configuration broke mid-flight would otherwise go blind to
    // the delegation that is still running.
    const harness = await setup({ FAKE_CONSULT_DOCTOR_OK: '0' })
    assert.equal((await harness.delegation.capabilities()).ready, false)
    const page = await harness.delegation.events('job-1')
    assert.equal(page.supported, true)
    assert.equal(page.events.length, 6)
    const received: DelegationEvent[] = []
    harness.delegation.watch('job-1', (event) => received.push(event))
    await until(() => received.some((event) => event.lifecycle?.phase === 'terminal') ? true : undefined)
    // ...while starting a new delegation still refuses, with doctor's diagnosis.
    await assert.rejects(harness.delegation.delegate({ prompt: 'p' }), (error: unknown) =>
      error instanceof DelegationError && error.code === 'not-ready')
  })
})

describe('events()', () => {
  it('projects the whole stream and reports the resume point', async () => {
    const harness = await setup()
    const page = await harness.delegation.events('job-1')
    assert.equal(page.supported, true)
    assert.deepEqual(page.events.map((event) => event.type), ['lifecycle', 'lifecycle', 'progress', 'blocked', 'discovery', 'lifecycle'])
    assert.deepEqual(page.events.map((event) => event.urgency), ['info', 'info', 'info', 'wake', 'info', 'info'])
    assert.equal(page.nextSeq, 3)
    const blocked = page.events.find((event) => event.type === 'blocked')
    assert.deepEqual(blocked?.data, { options: ['a', 'b'] })
  })

  it('passes a resume point through to consult', async () => {
    const harness = await setup()
    const page = await harness.delegation.events('job-1', 2)
    assert.deepEqual(page.events.map((event) => event.seq), [undefined, undefined, 3, undefined])
    const argv = of(harness, 'events').find((entry) => entry.argv[1] === 'job-1')?.argv
    assert.deepEqual(argv?.slice(-2), ['--since', '2'])
  })

  it('maps an unknown job to the infrastructure failure consult reports', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_EVENTS: '2' })
    await assert.rejects(harness.delegation.events('nope'), (error: unknown) =>
      error instanceof Error && !(error instanceof DelegationError))
  })
})

describe('watch()', () => {
  it('streams a live follow to its listener and ends at the terminal transition', async () => {
    const harness = await setup({ FAKE_CONSULT_EVENT_STEP_MS: '20' })
    const received: DelegationEvent[] = []
    harness.delegation.watch('job-1', (event) => received.push(event))
    await until(() => received.some((event) => event.lifecycle?.phase === 'terminal') ? true : undefined)
    assert.deepEqual(received.map((event) => event.type), ['lifecycle', 'lifecycle', 'progress', 'blocked', 'discovery', 'lifecycle'])
    const follows = of(harness, 'events').filter((entry) => entry.argv.includes('--follow'))
    assert.equal(follows.length, 1)
    assert.deepEqual(follows[0]?.argv, ['events', 'job-1', '--json', '--follow'])
    // A finished follow is never restarted, however long we wait.
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(of(harness, 'events').filter((entry) => entry.argv.includes('--follow')).length, 1)
  })

  it('resumes from the last delivered sequence when the follow dies mid-stream', async () => {
    const harness = await setup(
      { FAKE_CONSULT_EVENT_STEP_MS: '20', FAKE_CONSULT_FOLLOW_DIE_AFTER: '3' },
      { eventFollowRestartMs: 100 },
    )
    const received: DelegationEvent[] = []
    harness.delegation.watch('job-1', (event) => received.push(event))
    await until(() => received.some((event) => event.lifecycle?.phase === 'terminal') ? true : undefined)

    const follows = of(harness, 'events').filter((entry) => entry.argv.includes('--follow'))
    assert.equal(follows.length, 2, 'one death, one restart')
    assert.deepEqual(follows[0]?.argv, ['events', 'job-1', '--json', '--follow'])
    // The first follow died after delivering seq 1, so the restart resumes there.
    assert.deepEqual(follows[1]?.argv, ['events', 'job-1', '--json', '--follow', '--since', '1'])

    const seqs = received.filter((event) => event.seq !== undefined).map((event) => event.seq)
    assert.deepEqual(seqs, [1, 2, 3], 'no report is delivered twice and none is lost')
  })

  it('stops the follow process when the last listener unsubscribes', async () => {
    const harness = await setup({ FAKE_CONSULT_EVENT_STEP_MS: '400' })
    const received: DelegationEvent[] = []
    const unwatch = harness.delegation.watch('job-1', (event) => received.push(event))
    await until(() => received.length > 0 ? true : undefined)
    unwatch()
    const seen = received.length
    await new Promise((resolve) => setTimeout(resolve, 900))
    assert.equal(received.length, seen, 'a terminated follow delivers nothing further')
    assert.equal(of(harness, 'events').filter((entry) => entry.argv.includes('--follow')).length, 1)
  })

  it('shares one follow between listeners and keeps it until the last one leaves', async () => {
    const harness = await setup({ FAKE_CONSULT_EVENT_STEP_MS: '200' })
    const a: DelegationEvent[] = []
    const b: DelegationEvent[] = []
    const unwatchA = harness.delegation.watch('job-1', (event) => a.push(event))
    harness.delegation.watch('job-1', (event) => b.push(event))
    await until(() => a.length > 0 && b.length > 0 ? true : undefined)
    unwatchA()
    unwatchA()
    const before = b.length
    await until(() => b.length > before ? true : undefined)
    assert.equal(of(harness, 'events').filter((entry) => entry.argv.includes('--follow')).length, 1)
  })

  it('contains a listener that throws rather than tearing down the follow', async () => {
    const harness = await setup({ FAKE_CONSULT_EVENT_STEP_MS: '20' })
    const good: DelegationEvent[] = []
    harness.delegation.watch('job-1', () => { throw new Error('listener exploded') })
    harness.delegation.watch('job-1', (event) => good.push(event))
    await until(() => good.some((event) => event.lifecycle?.phase === 'terminal') ? true : undefined)
    assert.equal(good.length, 6)
  })

  it('feeds the global observation bus from every watched delegation', async () => {
    const harness = await setup({ FAKE_CONSULT_EVENT_STEP_MS: '20' })
    const observed: DelegationEvent[] = []
    const off = harness.delegation.onEvent((event) => observed.push(event))
    harness.delegation.watch('job-1', () => {})
    await until(() => observed.some((event) => event.lifecycle?.phase === 'terminal') ? true : undefined)
    off()
    assert.equal(observed.length, 6)
    assert.equal(observed.every((event) => event.jobId === 'job-1'), true)
  })

  it('gives up on an unknown job instead of restarting forever', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_EVENTS: '2' }, { eventFollowRestartMs: 100 })
    harness.delegation.watch('job-1', () => {})
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(of(harness, 'events').filter((entry) => entry.argv.includes('--follow')).length, 1)
  })
})

describe('steer()', () => {
  it('probes for the command and reports it as a capability', async () => {
    const supported = await setup()
    assert.equal((await supported.delegation.capabilities()).canSteer, true)
    const absent = await setup({ FAKE_CONSULT_NO_STEER: '1' })
    assert.equal((await absent.delegation.capabilities()).canSteer, false)
  })

  it('delivers guidance and reports it accepted', async () => {
    const harness = await setup()
    const outcome = await harness.delegation.steer('job-1', 'skip the migration; the schema is frozen')
    assert.deepEqual(outcome, { supported: true, accepted: true, detail: 'steered job-1' })
    const steer = of(harness, 'steer').find((entry) => entry.argv[1] === 'job-1')
    assert.deepEqual(steer?.argv, ['steer', 'job-1', '--message', 'skip the migration; the schema is frozen'])
  })

  it('reports a consult without the command as unsupported, without spawning a steer', async () => {
    const harness = await setup({ FAKE_CONSULT_NO_STEER: '1' })
    const outcome = await harness.delegation.steer('job-1', 'go left')
    assert.equal(outcome.supported, false)
    assert.match(outcome.supported === false ? outcome.reason : '', /no `steer` command/)
    assert.deepEqual(of(harness, 'steer').map((entry) => entry.argv), [['steer', '--help']])
  })

  it('reports an unsteerable delegation as unsupported', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_STEER: '1' })
    const outcome = await harness.delegation.steer('job-1', 'go left')
    assert.equal(outcome.supported, false)
    assert.match(outcome.supported === false ? outcome.reason : '', /inline runner/)
  })

  it('reports a steer already in flight as not accepted, and never retries it', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_STEER: '3' })
    const outcome = await harness.delegation.steer('job-1', 'go left')
    assert.deepEqual(outcome, { supported: true, accepted: false, detail: 'STEER_PENDING: a previous steer is still being delivered' })
    // A duplicate steer is worse than a missed one: exit 3 is the one place
    // this plugin does NOT apply its single contention retry.
    assert.equal(of(harness, 'steer').filter((entry) => entry.argv[1] === 'job-1').length, 1)
  })

  it('reports a delegation outside its running window as not accepted', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_STEER: '5' })
    const outcome = await harness.delegation.steer('job-1', 'go left')
    assert.equal(outcome.supported === true && outcome.accepted, false)
    assert.match((outcome as { detail?: string }).detail ?? '', /already finalized/)
  })

  it('lets an unknown job out as an infrastructure failure', async () => {
    const harness = await setup({ FAKE_CONSULT_EXIT_STEER: '2' })
    await assert.rejects(harness.delegation.steer('nope', 'go left'), (error: unknown) =>
      error instanceof Error && !(error instanceof DelegationError))
  })

  it('rejects oversized guidance before spawning anything', async () => {
    const harness = await setup()
    await assert.rejects(harness.delegation.steer('job-1', 'x'.repeat(16 * 1024 + 1)), (error: unknown) =>
      error instanceof Error && /the limit is 16384/.test(error.message))
    assert.equal(harness.invocations().length, 0, 'nothing ran: consult rejects rather than trims, so this is a caller bug')
  })

  it('rejects empty guidance', async () => {
    const harness = await setup()
    await assert.rejects(harness.delegation.steer('job-1', '   '), /non-empty/)
  })

  it('steers a delegation consult can no longer start new work for', async () => {
    // Same reasoning as events(): redirecting a delegation that is already
    // running needs a usable binary, not the ability to delegate.
    const harness = await setup({ FAKE_CONSULT_DOCTOR_OK: '0' })
    assert.equal((await harness.delegation.capabilities()).ready, false)
    assert.equal((await harness.delegation.steer('job-1', 'go left')).supported, true)
  })

  it('refuses to steer when the binary itself is unusable', async () => {
    const harness = await setup({ FAKE_CONSULT_VERSION: '0.12.0' })
    await assert.rejects(harness.delegation.steer('job-1', 'go left'), (error: unknown) =>
      error instanceof DelegationError && error.code === 'not-ready')
  })

  it('surfaces a steer echo through events() as an informational event', async () => {
    const harness = await setup({
      FAKE_CONSULT_EVENTS: JSON.stringify([
        { kind: 'report', type: 'progress', at: 'a', seq: 1, message: 'reading' },
        { kind: 'steer', type: 'steer', at: 'b', seq: 2, message: 'skip the migration' },
        { kind: 'lifecycle', type: 'terminal', at: 'c', status: 'completed' },
      ]),
    })
    const page = await harness.delegation.events('job-1')
    assert.deepEqual(page.events.map((event) => event.type), ['progress', 'steer', 'lifecycle'])
    assert.equal(page.events[1]?.urgency, 'info')
    assert.equal(page.nextSeq, 2, 'steers share the report sequence space')
  })
})
