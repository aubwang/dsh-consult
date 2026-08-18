#!/usr/bin/env node
/**
 * The full-loop drill: one supervisor, one delegate, and every seam between
 * them running for real.
 *
 * Nothing here is stubbed except the model. A real Cordis composition mounts
 * the real subprocess, tools, jobs, and agent services; the real provider
 * drives the real consult CLI; consult starts a real detached worker and
 * broker; and `drill/fake-delegate.mjs` answers as a real ACP agent over real
 * JSON-RPC stdio. What is being proved is that the whole chain carries a
 * decision from a stuck delegate up to its supervisor and an answer back down:
 *
 *   a. the supervisor delegates, and gets a background job
 *   b. the delegate reports BLOCKED mid-turn, and the supervisor is WOKEN
 *   c. the supervisor steers with a token, and consult accepts it
 *   d. the delegation completes, and its answer carries that token
 *   e. the event stream reads back blocked -> steer -> terminal in order
 *
 * Usage, from this package's directory (after `pnpm build`):
 *   DRILL_CONSULT_BIN=/path/to/consult/bin/consult node drill/full-loop.mjs
 *
 * Requires a consult with `report`, `events`, AND `steer`. Everything it
 * touches lives in a fresh temporary CONSULT_DATA_DIR and workspace, both
 * removed on the way out; no consult state on the machine is read or written.
 *
 * It must run somewhere UNIX SOCKETS CAN BE CREATED under the temp directory:
 * a background delegation is served by a job-scoped broker listening on one, so
 * a sandbox that denies `listen(2)` makes every job sit at `queued` with a
 * silent worker (the worker is spawned `stdio: 'ignore'`, so the EPERM never
 * reaches a terminal). If the drill hangs at step b with the job still queued,
 * check that first.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ConsultDelegation } from '../lib/provider.js'
import * as DelegateTools from '../lib/tools.js'

const run = promisify(execFile)
const DELEGATE = fileURLToPath(new URL('./fake-delegate.mjs', import.meta.url))
const CONSULT_BIN = process.env.DRILL_CONSULT_BIN ?? 'consult'
const TOKEN = 'USE-APPROACH-B'
/** Whole-drill ceiling; each wait below has its own, tighter bound. */
const DEADLINE_MS = Number(process.env.DRILL_DEADLINE_MS ?? '180000')

const proven = []
const startedAt = Date.now()
let step = 'setup'

const say = (text) => process.stdout.write(`${text}\n`)
const ok = (label) => { proven.push(label); say(`  PASS  ${label}`) }

function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** Poll until `probe` returns something, or fail the step by name. */
async function until(probe, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await probe()
    if (found !== undefined && found !== false) return found
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-consult-full-loop-'))
const workspaceRoot = path.join(root, 'workspace')
const dataDir = path.join(root, 'data')
let teardown = async () => {}

try {
  // ---------------------------------------------------------------- setup ---
  await fs.mkdir(workspaceRoot, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  await run('git', ['init', '-q'], { cwd: workspaceRoot })
  await fs.writeFile(path.join(workspaceRoot, 'README.md'), '# drill workspace\n')

  // Register the drill delegate as a real consult profile. `registryId:
  // opencode` is the never-confined family, which is what an out-of-tree
  // binary must be; `env` reaches the agent process, which is how it learns
  // where consult lives so it can report upward.
  await fs.writeFile(path.join(dataDir, 'profiles.json'), `${JSON.stringify({
    schemaVersion: 1,
    default: 'drill-delegate',
    hostDefaults: {},
    profiles: {
      'drill-delegate': {
        registryId: 'opencode',
        binary: process.execPath,
        args: [DELEGATE],
        env: { DRILL_CONSULT_BIN: CONSULT_BIN },
        installedAt: new Date().toISOString(),
      },
    },
  }, null, 2)}\n`)

  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LocalSubprocessRuntime),
    await ctx.plugin(AgentRegistry),
    await ctx.plugin(LocalJobRegistry),
  ]
  ctx.jobs.attachController('drill')
  // An absolute path is a consult CHECKOUT entry point, run through node; a
  // bare name is an installed executable resolved on PATH.
  const launch = path.isAbsolute(CONSULT_BIN)
    ? { consultPath: process.execPath, consultArgs: [CONSULT_BIN] }
    : { consultPath: CONSULT_BIN, consultArgs: [] }
  fibers.push(await ctx.plugin(ConsultDelegation, {
    ...launch,
    cwd: workspaceRoot,
    dataDir,
    // The drill delegate is an out-of-tree binary, which consult never confines.
    sandbox: 'inherit',
    defaultProfile: 'drill-delegate',
  }))
  fibers.push(await ctx.plugin(DelegateTools, {}))
  teardown = async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }

  // A supervisor that is idle, so a wake-urgency report opens a turn on it.
  const injected = []
  const followedUp = []
  const scope = ctx.plugin(() => {})
  const sessionId = SessionId('drill-supervisor')
  const supervisor = {
    id: sessionId,
    ctx: scope.ctx,
    status: 'idle',
    inject: (message) => injected.push(message),
    followup: (message) => followedUp.push(message),
    session: { id: sessionId, header: { version: 0, id: sessionId, createdAt: 0 } },
  }
  ctx.agents.register(supervisor)

  let callSequence = 0
  const callTool = (name, args) => ctx.tools.execute({
    callId: CallId(`drill-${(callSequence += 1)}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: supervisor,
  })
  const bodyOf = (message) => message.content.map((block) => block.text ?? '').join('\n')

  const capabilities = await ctx.delegation.capabilities()
  say(`consult ${capabilities.version ?? 'unknown'}  ready=${capabilities.ready}  canReport=${capabilities.canReport}  canSteer=${capabilities.canSteer}`)
  check(capabilities.ready, `consult is not ready: ${capabilities.diagnosis ?? 'no diagnosis'}`)
  check(capabilities.canReport, 'this consult has no `events` command; the drill needs report/events/steer')
  check(capabilities.canSteer, 'this consult has no `steer` command; the drill needs report/events/steer')

  // -------------------------------------------------------- a. delegate ----
  step = 'a. delegate'
  say('\na. the supervisor delegates')
  const started = await callTool('delegate', {
    prompt: 'Investigate the retry policy in src/. Report back when you need a decision.',
    label: 'full-loop drill',
    sandbox: 'inherit',
  })
  check(!started.isError, `delegate failed: ${JSON.stringify(started.error)}`)
  check(started.value.kind === 'started', `delegate returned ${JSON.stringify(started.value)}`)
  const jobId = started.value.job.id
  const backgroundJobId = started.value.backgroundJobId
  check(typeof backgroundJobId === 'string', 'the delegation was not tracked as a dsh background job')
  ok(`delegation ${jobId} queued and tracked as ${backgroundJobId}`)

  // --------------------------------------------- b. blocked report wakes ----
  step = 'b. blocked report wakes the supervisor'
  say('\nb. the delegate reports BLOCKED, and the supervisor is woken')
  const wake = await until(
    () => followedUp.find((message) => /reported: blocked/.test(bodyOf(message))),
    'a wake carrying the blocked report',
    90_000,
  )
  const wakeBody = bodyOf(wake)
  check(/need supervisor guidance/.test(wakeBody), `the wake did not carry the delegate's message:\n${wakeBody}`)
  check(/untrusted-delegate-output/.test(wakeBody), 'the delegate message was not framed as untrusted data')
  check(wake.source.kind === 'plugin' && wake.source.form === 'notice', 'the wake was not a plugin notice')
  check((wake.source.summary ?? '').length <= 120, 'the notice summary exceeded its bound')
  ok('a wake-urgency report opened a turn on the idle supervisor, framed as untrusted data')

  // ------------------------------------------------------------ c. steer ----
  step = 'c. steer'
  say('\nc. the supervisor steers')
  const steered = await callTool('delegate_steer', {
    job_id: jobId,
    guidance: `${TOKEN}: take the second approach and finish now.`,
  })
  check(!steered.isError, `delegate_steer failed: ${JSON.stringify(steered.error)}`)
  check(steered.value.outcome === 'accepted', `steer was not accepted: ${JSON.stringify(steered.value)}`)
  ok('consult accepted the guidance and re-prompted the same session')

  // -------------------------------------------------- d. completion ---------
  step = 'd. completion carries the guidance'
  say('\nd. the delegation completes, carrying the guidance')
  const snapshot = await ctx.jobs.wait(JobId(backgroundJobId), 90_000, supervisor)
  check(snapshot.status === 'completed', `the background job settled ${snapshot.status}: ${snapshot.detail ?? ''}`)
  const result = await callTool('delegate_result', { job_id: jobId })
  check(!result.isError, `delegate_result failed: ${JSON.stringify(result.error)}`)
  check(result.value.kind === 'result', `delegate_result returned ${JSON.stringify(result.value)}`)
  check(result.value.job.status === 'completed', `the delegation finished as ${result.value.job.status}, not completed`)
  check((result.value.finalText ?? '').includes(TOKEN),
    `the delegate's answer did not carry ${TOKEN}:\n${result.value.finalText ?? '(none)'}`)
  ok(`the delegation completed (never cancelled) and its answer carries ${TOKEN}`)

  // ------------------------------------------------------------ e. events ---
  step = 'e. event stream'
  say('\ne. the event stream reads back in order')
  const page = await ctx.delegation.events(jobId)
  check(page.supported, 'the event page came back unsupported')
  const types = page.events.map((event) => event.type)
  const blockedAt = types.indexOf('blocked')
  const steerAt = types.indexOf('steer')
  const terminal = page.events.find((event) => event.lifecycle?.phase === 'terminal')
  say(`   events: ${types.join(' -> ')}`)
  check(blockedAt !== -1, 'no blocked report in the event stream')
  check(steerAt !== -1, 'no steer echo in the event stream')
  check(blockedAt < steerAt, 'the steer was recorded before the report that caused it')
  check(terminal !== undefined, 'no terminal transition in the event stream')
  check(terminal.lifecycle.status === 'completed', `the terminal transition says ${terminal.lifecycle.status}`)
  const seqs = page.events.filter((event) => event.seq !== undefined).map((event) => event.seq)
  check(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]),
    `report and steer sequences are not monotonic: ${seqs.join(', ')}`)
  check(page.events[steerAt].urgency === 'info', 'the steer echo was not informational')
  check(!followedUp.concat(injected).some((message) => /reported: steer/.test(bodyOf(message))),
    'the supervisor was notified about its own steer')
  ok('blocked -> steer -> terminal(completed), sequences monotonic, steer echo never delivered upward')

  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  check(elapsed * 1000 <= DEADLINE_MS, `the drill took ${elapsed}s, over its ${DEADLINE_MS}ms ceiling`)
  say(`\nPASS — ${proven.length} steps proven in ${elapsed}s:`)
  for (const label of proven) say(`  - ${label}`)
  await teardown()
  await fs.rm(root, { recursive: true, force: true })
  process.exit(0)
} catch (error) {
  say(`\nFAIL at step "${step}": ${error.message}`)
  if (proven.length > 0) {
    say('proven before the failure:')
    for (const label of proven) say(`  - ${label}`)
  }
  say(`\nworkspace kept for inspection: ${root}`)
  await teardown().catch(() => {})
  process.exit(1)
}
