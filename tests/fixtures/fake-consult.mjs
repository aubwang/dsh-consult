#!/usr/bin/env node
/**
 * A spawnable stand-in for the real `consult` CLI.
 *
 * It is a real executable, not a stub object: the tests drive the actual
 * provider through the actual `ctx.subprocess` seam, so argv construction,
 * environment injection, stream collection, exit codes, and process lifetime
 * are all exercised for real. Only the agent behind consult is fake.
 *
 * Scenario control is entirely environmental, because that is the one channel
 * that survives the subprocess seam unchanged:
 *
 *   FAKE_CONSULT_VERSION        version printed by `--version`      (default 1.0.0)
 *   FAKE_CONSULT_VERSION_EXIT   make `--version` fail with this code (a pre-1.0 install)
 *   FAKE_CONSULT_DOCTOR_OK      '0' makes doctor report canDelegate:false
 *   FAKE_CONSULT_DOCTOR_FAIL_FIRST  number of leading doctor calls that report canDelegate:false
 *   FAKE_CONSULT_EXIT_<CMD>     force one subcommand's exit code (e.g. FAKE_CONSULT_EXIT_DELEGATE=3)
 *   FAKE_CONSULT_TRANSIENT_<CMD> number of leading invocations that exit with
 *                               FAKE_CONSULT_EXIT_<CMD> before succeeding
 *   FAKE_CONSULT_STATUS         job status reported by result/wait/status      (default completed)
 *   FAKE_CONSULT_FINAL_TEXT     outcome.finalText emitted by result/wait
 *   FAKE_CONSULT_ERROR_MESSAGE  outcome.errorMessage emitted by result/wait
 *   FAKE_CONSULT_DELAY_MS       sleep before answering (slow exit for wait)
 *   FAKE_CONSULT_LOG_LINES      lines the transcript starts with               (default 3)
 *   FAKE_CONSULT_LOG_GROW       lines the transcript gains per `logs` call     (default 0)
 *   FAKE_CONSULT_BAD_JSON       '1' makes job-bearing commands print non-envelope JSON
 *   FAKE_CONSULT_SCHEMA_VERSION schemaVersion stamped on envelopes             (default 1)
 *   FAKE_CONSULT_STATE          JSON file holding per-command invocation counters
 *   FAKE_CONSULT_RECORD         JSONL file every invocation is appended to (argv + consult env)
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const command = argv[0] ?? ''

record()

const counter = bumpCounter(command)
const forced = forcedExit(command, counter)

switch (command) {
  case '--version': {
    const versionExit = process.env.FAKE_CONSULT_VERSION_EXIT
    if (versionExit !== undefined) exitWith(Number(versionExit), 'unknown subcommand: --version\n')
    out(`${process.env.FAKE_CONSULT_VERSION ?? '1.0.0'}\n`)
    exit(0)
    break
  }
  case 'doctor':
    doctor()
    break
  case 'agents':
    out(`${JSON.stringify([
      { id: 'claude', default: true },
      { id: 'codex', default: false },
    ])}\n`)
    exit(0)
    break
  case 'delegate':
  case 'review':
    if (forced !== undefined) exitWith(forced, `${command} failed\n`)
    out(`${JSON.stringify(envelope({ status: 'queued', kind: command }))}\n`)
    exit(0)
    break
  case 'status':
    status()
    break
  case 'wait':
    await sleep()
    if (forced !== undefined) exitWith(forced, 'wait failed\n')
    out(`${JSON.stringify({ schemaVersion: schemaVersion(), jobs: waitIds().map((id) => payload({ id })) })}\n`)
    exit(0)
    break
  case 'result':
    if (forced !== undefined) exitWith(forced, 'result failed\n')
    out(`${JSON.stringify(envelope({ id: argv[1] }))}\n`)
    exit(0)
    break
  case 'logs':
    if (forced !== undefined) exitWith(forced, 'logs failed\n')
    out(logs())
    exit(0)
    break
  case 'cancel':
    if (forced !== undefined) exitWith(forced, 'cancel failed\n')
    out(`cancelled ${argv[1]}\n`)
    exit(0)
    break
  default:
    exitWith(2, `unknown subcommand: ${command}\n`)
}

function doctor() {
  const failFirst = Number(process.env.FAKE_CONSULT_DOCTOR_FAIL_FIRST ?? '0')
  const ok = process.env.FAKE_CONSULT_DOCTOR_OK !== '0' && counter > failFirst
  out(`${JSON.stringify({
    workspaceRoot: process.cwd(),
    canDelegate: ok,
    profile: {
      ok,
      selectedProfile: ok ? 'claude' : null,
      error: ok ? null : 'No profile selected',
    },
    jobs: { ok: true, error: null },
    brokers: { ok: true, error: null },
    authority: { ok, error: ok ? null : 'preflight failed' },
  })}\n`)
  exit(ok ? 0 : 1)
}

function status() {
  const id = argv[1] !== undefined && !argv[1].startsWith('--') ? argv[1] : undefined
  if (forced !== undefined) exitWith(forced, 'status failed\n')
  if (id === undefined) {
    out(`${JSON.stringify({
      schemaVersion: schemaVersion(),
      jobs: [payload({ id: 'job-1' }), payload({ id: 'job-2', status: 'running' })],
    })}\n`)
  } else {
    out(`${JSON.stringify(envelope({ id }))}\n`)
  }
  exit(0)
}

function logs() {
  const base = Number(process.env.FAKE_CONSULT_LOG_LINES ?? '3')
  const grow = Number(process.env.FAKE_CONSULT_LOG_GROW ?? '0')
  const total = base + grow * (counter - 1)
  const lines = []
  for (let index = 1; index <= total; index += 1) lines.push(`line ${index}`)
  const tailIndex = argv.indexOf('--tail')
  const tail = tailIndex === -1 ? lines.length : Number(argv[tailIndex + 1])
  return `${lines.slice(Math.max(0, lines.length - tail)).join('\n')}\n`
}

function waitIds() {
  const ids = []
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('--')) break
    ids.push(arg)
  }
  return ids.length > 0 ? ids : ['job-1']
}

function envelope(overrides = {}) {
  if (process.env.FAKE_CONSULT_BAD_JSON === '1') return { notAnEnvelope: true }
  return { schemaVersion: schemaVersion(), ...payload(overrides) }
}

function schemaVersion() {
  return Number(process.env.FAKE_CONSULT_SCHEMA_VERSION ?? '1')
}

function payload({ id = 'job-1', status = process.env.FAKE_CONSULT_STATUS ?? 'completed', kind = 'delegate' } = {}) {
  return {
    job: {
      id,
      label: labelArg(),
      kind,
      status,
      profile: agentArg() ?? 'claude',
      authority: { schemaVersion: 1, mode: modeArg(), confinement: sandboxArg(), allowFetch: false, allowExecute: false },
      mode: modeArg(),
      host: process.env.CONSULT_HOST ?? null,
      hostSessionId: process.env.CONSULT_HOST_SESSION_ID ?? null,
      prompt: 'prompt',
      submittedAt: '2026-08-18T00:00:00.000Z',
      startedAt: '2026-08-18T00:00:01.000Z',
      completedAt: status === 'queued' || status === 'running' ? null : '2026-08-18T00:01:00.000Z',
      model: null,
      effort: null,
      afterJobIds: [],
      resumeSessionId: null,
      reviewOfJobId: null,
      baseRef: null,
      includeDiff: false,
      isolated: argv.includes('--isolated'),
      allowExecute: false,
    },
    outcome: {
      stopReason: 'end_turn',
      sessionId: 'session-1',
      errorMessage: process.env.FAKE_CONSULT_ERROR_MESSAGE ?? null,
      finalText: process.env.FAKE_CONSULT_FINAL_TEXT ?? 'the delegate answer',
    },
    artifacts: {
      touchedFiles: ['src/a.ts'],
      logPath: '/tmp/fake/job-1.log',
      patchPath: null,
      patchBytes: null,
      touchedFilesPath: null,
      cleanupMetadataPath: null,
    },
    lineage: { chainId: 'chain-1', parentJobId: null, childJobIds: [], delegationDepth: 0 },
  }
}

function flagValue(flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

function agentArg() {
  return flagValue('--agent')
}

function labelArg() {
  return flagValue('--label') ?? null
}

function modeArg() {
  return argv.includes('--write') ? 'write' : 'read-only'
}

function sandboxArg() {
  return flagValue('--sandbox') ?? 'confined'
}

function forcedExit(name, count) {
  const code = process.env[`FAKE_CONSULT_EXIT_${name.toUpperCase()}`]
  if (code === undefined) return undefined
  const transient = process.env[`FAKE_CONSULT_TRANSIENT_${name.toUpperCase()}`]
  if (transient !== undefined && count > Number(transient)) return undefined
  return Number(code)
}

function bumpCounter(name) {
  const path = process.env.FAKE_CONSULT_STATE
  if (path === undefined) return 1
  let state = {}
  try {
    state = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    state = {}
  }
  const next = (state[name] ?? 0) + 1
  state[name] = next
  writeFileSync(path, JSON.stringify(state))
  return next
}

function record() {
  const path = process.env.FAKE_CONSULT_RECORD
  if (path === undefined) return
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CONSULT_') || key.startsWith('FAKE_PASSTHROUGH')) env[key] = value
  }
  appendFileSync(path, `${JSON.stringify({ argv, env, cwd: process.cwd() })}\n`)
}

async function sleep() {
  const ms = Number(process.env.FAKE_CONSULT_DELAY_MS ?? '0')
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
}

function out(text) {
  process.stdout.write(text)
}

function exit(code) {
  process.exitCode = code
  process.exit(code)
}

function exitWith(code, message) {
  process.stderr.write(message)
  process.exit(code)
}
