#!/usr/bin/env node
/**
 * Stage-B client: drive a REAL model supervisor over ACP and watch whether it
 * operates the delegation loop from the notices alone.
 *
 * The earlier stage-B attempt used the harness's one-shot headless runner,
 * which exits when the first turn ends — so a supervisor that delegated and
 * waited was killed before any notice could reach it. ACP keeps the agent alive
 * across turns, which is the whole reason for this surface.
 *
 * The question this answers is narrower than "did the model behave": it is
 * whether an AGENT-INITIATED turn — one the delegation's blocked report woke
 * through `followup()` — crosses the ACP boundary to a connected client at all.
 * `session/prompt` returns when the first turn goes idle; everything after that
 * arrives, if it arrives, as unsolicited `session/update` notifications.
 *
 * Usage, from this package's directory (after `pnpm build`):
 *   OPENROUTER_API_KEY=<key> node drill/stage-b-client.mjs
 *
 * It creates its own throwaway git workspace, points the ACP session at it, and
 * cancels any delegation still running when it stops.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HARNESS = process.env.DRILL_HARNESS ?? '/home/dev/dev/deepseek-harness'
const COMPOSITION = path.join(import.meta.dirname, 'stage-b-acp.cordis.yml')
const TOKEN = 'APPROACH-B'
const DEADLINE_MS = Number(process.env.DRILL_DEADLINE_MS ?? '600000')

const DELEGATE_PROMPT = [
  'Decide how a retry helper in this codebase should be named: APPROACH-A (name it `retry`) or APPROACH-B (name it `withRetry`).',
  '',
  'You cannot decide this alone - the supervisor holds the convention. Do this, in order:',
  '1. Run this exact command: consult report --type blocked --message "need guidance: A or B?"',
  '   The `consult` CLI is on your PATH, and CONSULT_PARENT_JOB and CONSULT_WORKSPACE are already set in your environment, so it needs no other arguments.',
  '   If your sandbox blocks that command, retry it with escalated permissions - it is expected and approved.',
  '2. Then STOP and WAIT for supervisor guidance. Do not finish your turn, do not guess, and do not pick an approach yourself.',
  '3. When guidance arrives, follow it and reply with ONE line naming the approach you were told to use.',
  '',
  'Do not read or write any files. Do not run any other commands.',
].join('\n')

const SUPERVISOR_PROMPT = [
  'You are supervising one delegated task. Use only the delegate* tools; do not do the work yourself, and do not use bash.',
  '',
  'STEP 1. Call `delegate` now with:',
  '- profile: "codex"',
  '- mode: "write"',
  '- extensions: {"sandbox": "inherit"}',
  '- label: "naming decision"',
  '- prompt: exactly this text between the markers, without the markers:',
  '<<<PROMPT',
  DELEGATE_PROMPT,
  'PROMPT',
  '',
  'STEP 2. You will be notified when the delegate reports that it is blocked. When that notice arrives, '
  + `the convention is ${TOKEN}. Call \`delegate_steer\` with that job id and guidance telling it to use ${TOKEN}.`,
  '',
  'STEP 3. You will be notified when the delegation finishes. Then call `delegate_result` with that job id, '
  + "and say: FINAL ANSWER: followed by the delegate's final answer verbatim.",
  '',
  // Born of an earlier run: given a not-ready diagnosis, the model spent sixty
  // tool calls trying to rewrite the machine's consult configuration.
  'If a delegation tool reports not-ready or any failure, stop and report the failure verbatim. '
  + 'Do not attempt to repair, configure, or work around the environment.',
].join('\n')

const started = Date.now()
const say = (text) => process.stdout.write(`${text}\n`)
const stamp = () => `[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s]`

// ── throwaway workspace ─────────────────────────────────────────────────────
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-stageb-acp-'))
await run('git', ['init', '-q'], { cwd: workspace })
await fs.writeFile(path.join(workspace, 'README.md'), '# stage-b acp workspace\n')
say(`workspace: ${workspace}`)

// ── the ACP server ──────────────────────────────────────────────────────────
const server = spawn(process.execPath, [
  '--import', path.join(HARNESS, 'node_modules/tsx/dist/esm/index.mjs'),
  path.join(HARNESS, 'packages/examples/acp-demo/src/bin.ts'),
  '--config', COMPOSITION,
], {
  cwd: workspace,
  // TSX_TSCONFIG_PATH is what lets the source bin resolve `@deepseek-ai/cordis`
  // through the harness's tsconfig paths from a foreign cwd.
  env: { ...process.env, TSX_TSCONFIG_PATH: path.join(HARNESS, 'tsconfig.json') },
  stdio: ['pipe', 'pipe', 'pipe'],
})
// A server that dies during boot must fail the drill immediately rather than
// leaving the client waiting on a request nobody will ever answer.
server.on('exit', (code, signal) => {
  for (const waiter of pendingWaiters()) waiter.reject(new Error(`the ACP server exited (code=${code} signal=${signal}) before answering`))
})
server.stderr.setEncoding('utf8')
server.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n')) if (line.trim()) say(`${stamp()} [server] ${line.slice(0, 300)}`)
})

// ── JSON-RPC plumbing ───────────────────────────────────────────────────────
let nextId = 1
const pending = new Map()
const pendingWaiters = () => {
  const waiters = [...pending.values()]
  pending.clear()
  return waiters
}
const seen = { toolCalls: [], updates: 0, turns: 0 }
let delegationJobId
let finalAnswer

const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`)

const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  send({ jsonrpc: '2.0', id, method, params })
})

/** Compact one session/update for a human reading the transcript. */
function renderUpdate(update) {
  const kind = update?.sessionUpdate
  if (kind === 'agent_message_chunk') {
    const text = update.content?.text ?? ''
    return text.trim().length === 0 ? undefined : `assistant: ${text.trim().slice(0, 500)}`
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const title = update.title ?? update.toolCallId ?? '?'
    const raw = update.rawInput === undefined ? '' : ` ${JSON.stringify(update.rawInput).slice(0, 200)}`
    return `${kind}: ${title}${raw}`
  }
  return `${kind}: ${JSON.stringify(update).slice(0, 200)}`
}

function onNotification(message) {
  if (message.method !== 'session/update') {
    say(`${stamp()} [notify] ${message.method} ${JSON.stringify(message.params ?? {}).slice(0, 200)}`)
    return
  }
  seen.updates += 1
  const line = renderUpdate(message.params?.update)
  if (line === undefined) return
  say(`${stamp()} ${line}`)
  const text = message.params?.update?.content?.text ?? ''
  const job = /\b(job-[A-Za-z0-9_-]{4,})\b/.exec(text)
  if (job !== null) delegationJobId ??= job[1]
  if (/FINAL ANSWER/i.test(text) && text.includes(TOKEN)) finalAnswer = text.trim()
}

let buffer = ''
server.stdout.setEncoding('utf8')
server.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim().length === 0) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      say(`${stamp()} [unparsed] ${line.slice(0, 200)}`)
      continue
    }
    if (message.id !== undefined && message.method === undefined) {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (waiter === undefined) continue
      if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
      continue
    }
    if (message.id !== undefined && message.method !== undefined) {
      // A server-to-client request. The supervisor is told not to use bash, so
      // anything asking for permission is unexpected: refuse it and say so
      // loudly rather than quietly widening what this run may do.
      say(`${stamp()} [server-request] ${message.method} ${JSON.stringify(message.params ?? {}).slice(0, 300)}`)
      send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })
      continue
    }
    onNotification(message)
  }
})

const finish = async (code, verdict) => {
  say(`\n${verdict}`)
  if (delegationJobId !== undefined && code !== 0) {
    say(`stopping delegation ${delegationJobId}`)
    await run('consult', ['cancel', delegationJobId], { cwd: workspace }).catch(() => {})
  }
  server.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 500))
  say(`workspace kept for inspection: ${workspace}`)
  process.exit(code)
}

// ── the run ─────────────────────────────────────────────────────────────────
try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })
  say(`${stamp()} initialize -> protocolVersion=${init.protocolVersion}`)

  const session = await request('session/new', { cwd: workspace, mcpServers: [] })
  say(`${stamp()} session/new -> ${session.sessionId}`)

  say(`${stamp()} session/prompt (turn 1: the supervisor should delegate)`)
  const first = await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: SUPERVISOR_PROMPT }],
  })
  seen.turns += 1
  say(`${stamp()} turn 1 ended: stopReason=${first.stopReason}`)

  if (finalAnswer !== undefined) {
    await finish(0, `PASS — the supervisor completed the whole loop inside its first turn.\n${finalAnswer}`)
  }

  // The interesting part: everything from here is agent-initiated. If the
  // blocked report's followup wakes the supervisor AND that turn streams to a
  // connected ACP client, updates keep arriving with no further prompt.
  say(`${stamp()} watching for agent-initiated turns (no further prompts will be sent)…`)
  const deadline = started + DEADLINE_MS
  while (Date.now() < deadline && finalAnswer === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  if (finalAnswer !== undefined) {
    await finish(0, `PASS — the wake crossed the ACP boundary and the supervisor closed the loop.\n${finalAnswer}`)
  }
  await finish(1, `FAIL — no final answer within ${Math.round(DEADLINE_MS / 1000)}s.\n`
    + `session/update notifications seen after turn 1: ${seen.updates}.\n`
    + 'If that count did not grow after the turn ended, the followup-woken turn did not reach this client, '
    + 'which is a finding about the ACP driver rather than about the delegation loop.')
} catch (error) {
  await finish(1, `FAIL — ${error.message}`)
}
