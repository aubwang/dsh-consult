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
import { DelegationError } from '../src/seam.ts'

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
    assert.equal(capabilities.canSteer, false)
    assert.equal(capabilities.canReport, false)
  })

  it('rejects the stale 0.12.0 install without running doctor', async () => {
    const harness = await setup({ FAKE_CONSULT_VERSION: '0.12.0' })
    const capabilities = await harness.delegation.capabilities()
    assert.equal(capabilities.ready, false)
    assert.match(capabilities.diagnosis ?? '', />=1\.0\.0 <2\.0\.0/)
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

  it('answers steer and events with a typed unsupported outcome, never a crash', async () => {
    const harness = await setup()
    const steer = await harness.delegation.steer('job-1', 'try the other approach')
    assert.equal(steer.supported, false)
    assert.match(steer.supported === false ? steer.reason : '', /Cancel the job and re-delegate/)
    const events = await harness.delegation.events('job-1')
    assert.equal(events.supported, false)
    assert.deepEqual([...events.events], [])
    assert.equal(typeof harness.delegation.onEvent(() => {}), 'function')
  })
})
