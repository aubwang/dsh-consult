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
 * Two modes. By default the delegate is `drill/fake-delegate.mjs`, so the loop
 * is deterministic and free. With `DRILL_PROFILE=<name>` it is the REAL agent
 * that profile names, copied out of the user's own consult registry so
 * authentication and configuration are exercised as they actually are — the
 * live dogfood. Real mode spends that agent's tokens, so the prompt is tiny,
 * the effort is low, and nothing retries.
 *
 * Usage, from this package's directory (after `pnpm build`):
 *   DRILL_CONSULT_BIN=/path/to/consult/bin/consult node drill/full-loop.mjs
 *   DRILL_PROFILE=codex node drill/full-loop.mjs
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
import { selectProfileRegistry } from './profiles.ts'

const run = promisify(execFile)
const DELEGATE = fileURLToPath(new URL('./fake-delegate.mjs', import.meta.url))
const CONSULT_BIN = process.env.DRILL_CONSULT_BIN ?? 'consult'
const TOKEN = 'USE-APPROACH-B'
/** Name of a real consult profile to dogfood against; absent runs the fake delegate. */
const REAL_PROFILE = process.env.DRILL_PROFILE
const LIVE = REAL_PROFILE !== undefined

/**
 * A real agent thinks, and its turn is a network round trip; the fake one is a
 * setTimeout. Every bound below is generous in live mode and tight in fake
 * mode, so a fake-mode regression still fails fast.
 */
const REPORT_WAIT_MS = Number(process.env.DRILL_REPORT_WAIT_MS ?? (LIVE ? '300000' : '90000'))
const FINISH_WAIT_MS = Number(process.env.DRILL_FINISH_WAIT_MS ?? (LIVE ? '600000' : '90000'))
/** Whole-drill ceiling; each wait above has its own, tighter bound. */
const DEADLINE_MS = Number(process.env.DRILL_DEADLINE_MS ?? (LIVE ? '900000' : '180000'))

/**
 * The live prompt has to teach the loop, because a real agent has no reason to
 * guess that reporting upward is available. It stays read-only and tiny: the
 * point is the round trip, not the work.
 */
const LIVE_PROMPT = [
  'Decide how a retry helper in this codebase should be named: APPROACH-A (name it `retry`) or APPROACH-B (name it `withRetry`).',
  '',
  'You cannot decide this alone — the supervisor holds the convention. Do this, in order:',
  '1. Run this exact command: consult report --type blocked --message "need guidance: A or B?"',
  '   The `consult` CLI is on your PATH, and CONSULT_PARENT_JOB and CONSULT_WORKSPACE are already set in your environment, so it needs no other arguments.',
  '   If your sandbox blocks that command, retry it with escalated permissions — it is expected and approved.',
  '2. Then STOP and WAIT for supervisor guidance. Do not finish your turn, do not guess, and do not pick an approach yourself.',
  '3. When guidance arrives, follow it and reply with ONE line naming the approach you were told to use.',
  '',
  'Do not read or write any files. Do not run any other commands.',
].join('\n')

const FAKE_PROMPT = 'Investigate the retry policy in src/. Report back when you need a decision.'

/**
 * The wording each delegate is asked to report, which the wake assertion looks
 * for. It lives beside the prompts because it IS part of the prompt: the two
 * drift apart the moment one is edited alone, which is exactly what happened
 * the first time live mode reported successfully.
 */
const REPORT_MARKER = LIVE ? 'need guidance' : 'need supervisor guidance'

const proven = []
const startedAt = Date.now()
let step = 'setup'
/** Set once a delegation exists, so a failure can stop it before unwinding. */
let liveDelegation

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

  // The registry is throwaway either way; only WHERE the record comes from
  // differs. Fake mode fabricates one for the drill's own agent (`registryId:
  // opencode` is the never-confined family an out-of-tree binary must be, and
  // `env` reaches the agent process, which is how it learns where consult
  // lives). Live mode copies the user's real record so auth and configuration
  // are exercised as they actually are — the drill never writes to the user's
  // own registry.
  const profileName = REAL_PROFILE ?? 'drill-delegate'
  let registry
  if (LIVE) {
    const sourceDir = process.env.DRILL_SOURCE_DATA_DIR ?? process.env.CONSULT_DATA_DIR ?? path.join(os.homedir(), '.consult')
    const sourcePath = path.join(sourceDir, 'profiles.json')
    let source
    try {
      source = JSON.parse(await fs.readFile(sourcePath, 'utf8'))
    } catch (error) {
      throw new Error(`could not read the consult registry at ${sourcePath}: ${error.message}`)
    }
    registry = selectProfileRegistry(source, profileName)
    say(`live mode: copied the "${profileName}" profile from ${sourcePath}`)
  } else {
    registry = {
      schemaVersion: 1,
      default: profileName,
      hostDefaults: {},
      profiles: {
        [profileName]: {
          registryId: 'opencode',
          binary: process.execPath,
          args: [DELEGATE],
          env: { DRILL_CONSULT_BIN: CONSULT_BIN },
          installedAt: new Date().toISOString(),
        },
      },
    }
  }
  await fs.writeFile(path.join(dataDir, 'profiles.json'), `${JSON.stringify(registry, null, 2)}\n`)

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
    // The delegate must be able to exec `consult report`, which a confined
    // delegation cannot; inherit is the mode that makes upward reporting work.
    sandbox: 'inherit',
    defaultProfile: profileName,
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

  if (LIVE) {
    // Reporting upward needs the report-exec carve-out, and the published
    // build and the carve-out build both call themselves 1.2.0 — so this asks
    // the binary rather than its version, and asks BEFORE spending a token.
    let features
    try {
      const probe = await run(CONSULT_BIN, ['capabilities', '--json'], { env: { ...process.env, CONSULT_DATA_DIR: dataDir } })
      features = JSON.parse(probe.stdout).features ?? {}
    } catch {
      say('   (this consult has no `capabilities` command; cannot check for the report-exec carve-out)')
      features = undefined
    }
    if (features !== undefined) {
      say(`   consult features: ${Object.entries(features).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}`)
      check(
        features.reportExec === true,
        'this consult has no report-exec carve-out (features.reportExec), so a real delegate cannot run `consult report`. '
        + 'Point DRILL_CONSULT_BIN at a build that has it.',
      )
    }
  }

  const capabilities = await ctx.delegation.capabilities()
  say(`consult ${capabilities.version ?? 'unknown'}  ready=${capabilities.ready}  canReport=${capabilities.canReport}  canSteer=${capabilities.canSteer}  extensions=${Object.keys(capabilities.extensions).join(',')}`)
  check(capabilities.ready, `consult is not ready: ${capabilities.diagnosis ?? 'no diagnosis'}`)
  check(capabilities.canReport, 'this consult has no `events` command; the drill needs report/events/steer')
  check(capabilities.canSteer, 'this consult has no `steer` command; the drill needs report/events/steer')

  // -------------------------------------------------------- a. delegate ----
  step = 'a. delegate'
  say('\na. the supervisor delegates')
  const started = await callTool('delegate', {
    prompt: LIVE ? LIVE_PROMPT : FAKE_PROMPT,
    label: 'full-loop drill',
    // Write mode is what makes a real agent able to report at all: codex only
    // asks to escalate a blocked command when it is running in write mode, and
    // its read-only mode refuses to ask client-side, so the report's log append
    // can never land. The fake delegate spawns its own subprocess and needs
    // none of that, so fake mode stays read-only.
    ...LIVE ? { mode: 'write', effort: 'low' } : {},
    // Confinement is provider-specific, so it travels in the extensions bag
    // rather than as a standard spec field (seam v2).
    extensions: { sandbox: 'inherit' },
  })
  check(!started.isError, `delegate failed: ${JSON.stringify(started.error)}`)
  check(started.value.kind === 'started', `delegate returned ${JSON.stringify(started.value)}`)
  const jobId = started.value.job.id
  const backgroundJobId = started.value.backgroundJobId
  liveDelegation = { jobId, cancel: () => ctx.delegation.cancel(jobId) }
  check(typeof backgroundJobId === 'string', 'the delegation was not tracked as a dsh background job')
  ok(`delegation ${jobId} queued and tracked as ${backgroundJobId}`)

  // --------------------------------------------- b. blocked report wakes ----
  step = 'b. blocked report wakes the supervisor'
  say('\nb. the delegate reports BLOCKED, and the supervisor is woken')
  if (LIVE) say(`   (waiting up to ${Math.round(REPORT_WAIT_MS / 1000)}s for a real agent)`)
  // A real agent may simply not follow the instruction, which is a different
  // failure from the plumbing breaking — so the wait races the report against
  // the delegation finishing without one, and says which happened.
  const reported = await until(
    () => {
      const wake = followedUp.find((message) => /reported: blocked/.test(bodyOf(message)))
      if (wake !== undefined) return { wake }
      const settled = ctx.jobs.list(supervisor).find((job) => job.id === backgroundJobId && job.status !== 'running')
      return settled === undefined ? undefined : { settled }
    },
    'a wake carrying the blocked report',
    REPORT_WAIT_MS,
  )
  if (reported.wake === undefined) {
    const answer = await callTool('delegate_result', { job_id: jobId })
    const finalText = answer.isError ? '(unreadable)' : (answer.value.finalText ?? '(none)')
    // Three different failures look the same from here, so name which one it is.
    // A real ACP agent routes command execution through the client's permission
    // system, and consult denies every execute request today — so an agent that
    // TRIED and was refused is an upstream limitation, not a bad prompt.
    const denied = /approval|permission|denied|not allowed|escalat/i.test(finalText)
    throw new Error(
      `the delegation finished ${reported.settled.status} WITHOUT reporting blocked.\n`
      + (denied
        ? 'Its answer mentions a blocked or denied command. Reporting upward needs BOTH: a consult build with the '
          + 'report-exec carve-out (`consult capabilities --json` → features.reportExec) AND a profile whose own '
          + 'agent mode will run or escalate the command. With codex that means WRITE mode — read-only codex '
          + 'refuses to request escalation client-side, so the report can never land. Check the delegation mode '
          + 'and the consult build before suspecting this plugin.'
        : 'Its answer does not mention a denied command, so the agent most likely ignored the report instruction — '
          + 'a prompt problem rather than a plumbing one.')
      + `\nIts answer was:\n${finalText}`,
    )
  }
  const wake = reported.wake
  const wakeBody = bodyOf(wake)
  check(wakeBody.includes(REPORT_MARKER), `the wake did not carry the delegate's message:\n${wakeBody}`)
  check(/untrusted-delegate-output/.test(wakeBody), 'the delegate message was not framed as untrusted data')
  check(wake.source.kind === 'plugin' && wake.source.form === 'notice', 'the wake was not a plugin notice')
  check((wake.source.summary ?? '').length <= 120, 'the notice summary exceeded its bound')
  ok('a wake-urgency report opened a turn on the idle supervisor, framed as untrusted data')

  // ------------------------------------------------------------ c. steer ----
  step = 'c. steer'
  say('\nc. the supervisor steers')
  const steered = await callTool('delegate_steer', {
    job_id: jobId,
    guidance: LIVE
      ? `Use APPROACH-B. Reply with one line naming it, and include the exact token ${TOKEN} in that line.`
      : `${TOKEN}: take the second approach and finish now.`,
  })
  check(!steered.isError, `delegate_steer failed: ${JSON.stringify(steered.error)}`)
  check(steered.value.outcome === 'accepted', `steer was not accepted: ${JSON.stringify(steered.value)}`)
  ok('consult accepted the guidance and re-prompted the same session')

  // -------------------------------------------------- d. completion ---------
  step = 'd. completion carries the guidance'
  say('\nd. the delegation completes, carrying the guidance')
  if (LIVE) say(`   (waiting up to ${Math.round(FINISH_WAIT_MS / 1000)}s for the steered turn)`)
  const snapshot = await ctx.jobs.wait(JobId(backgroundJobId), FINISH_WAIT_MS, supervisor)
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

  liveDelegation = undefined
  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  check(elapsed * 1000 <= DEADLINE_MS, `the drill took ${elapsed}s, over its ${DEADLINE_MS}ms ceiling`)
  say(`\nPASS — ${proven.length} steps proven in ${elapsed}s:`)
  for (const label of proven) say(`  - ${label}`)
  await teardown()
  await fs.rm(root, { recursive: true, force: true })
  process.exit(0)
} catch (error) {
  say(`\nFAIL at step "${step}": ${error.message}`)
  // A live delegation outlives this process — it is a detached worker with a
  // real agent attached — and teardown cannot reach it, because disposing the
  // provider removes the very service the job's cancel hook calls. Stop it here
  // instead of leaving an agent waiting for guidance that will never come.
  if (liveDelegation !== undefined) {
    say(`stopping the delegation ${liveDelegation.jobId} it left running`)
    await liveDelegation.cancel().catch((cancelError) => say(`  (cancel failed: ${cancelError.message})`))
  }
  if (proven.length > 0) {
    say('proven before the failure:')
    for (const label of proven) say(`  - ${label}`)
  }
  say(`\nworkspace kept for inspection: ${root}`)
  await teardown().catch(() => {})
  process.exit(1)
}
