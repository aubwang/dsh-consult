/**
 * Service Provider for the delegation seam, backed by the real `consult` CLI.
 * Every invocation goes through `ctx.subprocess.spawn` — never `node:child_process` —
 * so confinement, the credential scrub, bounded collection, tree-kill, and
 * remote execution worlds all apply to delegated work exactly as they do to the
 * bash tool.
 *
 * The class is a thin shell: argv construction, envelope parsing, exit-code
 * mapping, and bounding live in `./consult-cli.ts` as injectable functions.
 * @module @aubwang/dsh-consult/provider
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  boundLines,
  buildConsultEnv,
  countActiveDelegations,
  delegateArgs,
  eventsArgs,
  gateConsultVersion,
  mapExit,
  parseDoctorReport,
  parseEventLine,
  parseEventsEnvelope,
  parseJobCollection,
  parseJobEnvelope,
  projectJob,
  projectResult,
  reviewArgs,
  runConsult,
  runConsultWithRetry,
  steerArgs,
  mapSteerExit,
  MAX_STEER_GUIDANCE_BYTES,
  type ConsultInvocation,
  type ConsultSpawn,
} from './consult-cli.ts'
import {
  DelegationError,
  DelegationService,
  type DelegateSpec,
  type DelegationCallOptions,
  type DelegationCapabilities,
  type DelegationEvent,
  type DelegationEventPage,
  type DelegationJob,
  type DelegationJobId,
  type DelegationMode,
  type DelegationResult,
  type DelegationSandbox,
  type ReviewSpec,
  type SteerOutcome,
} from './seam.ts'

export const name = 'consult-delegation'

/** Deployment configuration for the consult-backed delegation provider. */
export interface Config {
  /**
   * Executable to run. A bare name is resolved through the subprocess
   * provider's scrubbed PATH; an absolute path is verified. Default `consult`.
   */
  consultPath?: string
  /**
   * Fixed arguments inserted between the executable and the subcommand. This is
   * what lets a checkout be driven directly:
   * `consultPath: 'node', consultArgs: ['/path/to/consult/bin/consult']`.
   */
  consultArgs?: string[]
  /** Workspace root every invocation runs in. Defaults to the harness process cwd. */
  cwd?: string
  /** Relocates consult's state directory (`CONSULT_DATA_DIR`). */
  dataDir?: string
  /** Delegate identity used when a call omits one; otherwise consult's own default applies. */
  defaultProfile?: string
  /** Authority applied when a delegate call omits `mode`. */
  defaultMode?: DelegationMode
  /** Confinement applied when a call omits `sandbox`. */
  sandbox?: DelegationSandbox
  /** Per-stream in-memory cap for every consult invocation; overflow keeps the tail. */
  maxOutputBytes?: number
  /** Byte cap for each model-facing delegate-authored text field (`finalText`, log tails). */
  maxTextBytes?: number
  /** Rendered log lines returned when a caller does not ask for a specific tail. */
  logTailLines?: number
  /** Bound for one seam `wait` before it reports `timeout`; background collection re-waits. */
  waitTimeoutMs?: number
  /**
   * How long a FAILED preflight is cached before the next call re-probes.
   * Preflight really launches the configured profile, so a model retrying
   * `delegate` in a loop against a broken install would otherwise pay that cost
   * on every attempt. `0` re-probes on every call.
   */
  preflightRetryMs?: number
  /**
   * Delay before restarting an event follow that died while its delegation was
   * still live — consult's own follow deadline is the routine cause.
   */
  eventFollowRestartMs?: number
  /** SIGTERM→SIGKILL grace for every consult invocation. */
  graceMs?: number
  /**
   * Environment entries forwarded to consult past the subprocess service's
   * credential scrub (which drops `KEY|PASSWORD|SECRET|TOKEN` names). Needed
   * when a profile authenticates from the host environment rather than its own
   * config directory. Managed `CONSULT_HOST*` / `CONSULT_DATA_DIR` values are
   * layered after this map and always win.
   */
  env?: Record<string, string>
}

/** Resolved shape after schemastery applied the defaults. */
type ResolvedConfig =
  & Required<Omit<Config, 'cwd' | 'dataDir' | 'defaultProfile' | 'env'>>
  & Pick<Config, 'cwd' | 'dataDir' | 'defaultProfile' | 'env'>

/** Memoized preflight state: what `--version`, `doctor`, and `agents` reported. */
interface PreflightState {
  ready: boolean
  /**
   * Whether the configured binary is a consult this plugin can talk to at all:
   * it resolved, ran, and passed the semver gate. Independent of whether a
   * profile is configured — reading an existing delegation needs a usable
   * binary, not the ability to start a new delegation.
   */
  usable: boolean
  version?: string
  profiles: string[]
  defaultProfile?: string
  /** Whether the configured consult exposes the `events` command. */
  canReport: boolean
  /** Whether the configured consult exposes the `steer` command. */
  canSteer: boolean
  /** Delegations already active in this workspace when this preflight succeeded. */
  activeFromEarlierSessions: number
  diagnosis?: string
}

const STEER_UNSUPPORTED = 'this consult build has no `steer` command, so a running delegation cannot be redirected in place. '
  + 'Stop it and delegate again with the corrected prompt, or install a consult with `consult steer`.'
const EVENTS_UNSUPPORTED = 'this consult build has no `events` command, so a delegate cannot report upward mid-turn. '
  + 'Read progress with delegate_logs instead, or install a consult with `consult report`/`consult events`.'

/**
 * Consecutive follow restarts that produced no event before dying. A broken
 * install must not turn into an unbounded respawn loop, and a follow that is
 * genuinely working resets the count on its first event.
 */
const MAX_BARREN_FOLLOW_RESTARTS = 5

/** One live follow of a single delegation's event stream. */
interface Watch {
  listeners: Set<(event: DelegationEvent) => void>
  options: DelegationCallOptions | undefined
  /** Highest report sequence delivered so far; the resume point after a restart. */
  lastSeq: number
  /** Set once the terminal lifecycle transition arrived; no further follow starts. */
  finished: boolean
  closed: boolean
  handle: SubprocessHandle | undefined
  restart: ReturnType<typeof setTimeout> | undefined
  barrenRestarts: number
  /** Releases the ctx.effect that owns this follow's process lifetime. */
  release: (() => void) | undefined
}

/**
 * Delegation over the consult CLI.
 *
 * Preflight (`consult --version` semver gate, then `consult doctor --json`) is
 * lazy and memoized: it runs on first use, and a NOT-ready outcome clears the
 * memo so the next call re-probes. Preflight never throws out of the plugin —
 * a broken or missing consult becomes a `not-ready` domain failure carrying
 * doctor's own diagnosis.
 */
export class ConsultDelegation extends DelegationService {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    consultPath: z.string().default('consult'),
    consultArgs: z.array(z.string()).default([]),
    cwd: z.string(),
    dataDir: z.string(),
    defaultProfile: z.string(),
    defaultMode: z.union(['read-only', 'write'] as const).default('read-only'),
    sandbox: z.union(['confined', 'inherit'] as const).default('confined'),
    maxOutputBytes: z.number().min(1024).default(64_000),
    maxTextBytes: z.number().min(256).default(16_000),
    logTailLines: z.number().min(1).default(40),
    waitTimeoutMs: z.number().min(1_000).default(1_500_000),
    preflightRetryMs: z.number().min(0).default(30_000),
    eventFollowRestartMs: z.number().min(100).default(2_000),
    graceMs: z.number().min(1).default(5_000),
    env: z.dict(z.string()),
  })

  readonly config: ResolvedConfig

  private commandMemo: Promise<string[]> | undefined
  private preflightMemo: Promise<PreflightState> | undefined
  /** When the cached preflight settled NOT ready; undefined while it is healthy. */
  private preflightFailedAt: number | undefined
  private readonly watches = new Map<DelegationJobId, Watch>()
  private readonly observers = new Set<(event: DelegationEvent) => void>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    // Disposal stops every follow: the per-process effect kills the child, and
    // this closes the loops that would otherwise schedule a restart after it.
    ctx.effect(() => () => {
      for (const [id, watch] of [...this.watches]) this.closeWatch(id, watch)
    })
  }

  /** The subprocess seam's spawn callable, resolved per call so a provider swap is picked up. */
  private get spawn(): ConsultSpawn {
    return (spec) => this.ctx.subprocess.spawn(spec)
  }

  /**
   * Resolve the consult command once. A resolution failure clears the memo so a
   * later call retries after the operator fixes PATH or `consultPath`.
   */
  private resolveCommand(): Promise<string[]> {
    if (this.commandMemo === undefined) {
      const memo = this.ctx.subprocess
        .resolveExecutable(this.config.consultPath)
        .then((executable) => [executable, ...this.config.consultArgs])
      memo.catch(() => { this.commandMemo = undefined })
      this.commandMemo = memo
    }
    return this.commandMemo
  }

  /** Assemble one invocation's executable, directory, environment, and budgets. */
  private async invocation(options: DelegationCallOptions | undefined, signal?: AbortSignal): Promise<ConsultInvocation> {
    const effectiveSignal = signal ?? options?.signal
    return {
      command: await this.resolveCommand(),
      // A configured workspace is an explicit deployment override; otherwise the
      // caller's own workspace (an agent session's cwd) decides.
      cwd: this.config.cwd ?? options?.cwd ?? process.cwd(),
      env: buildConsultEnv({
        hostSessionId: options?.hostSessionId,
        dataDir: this.config.dataDir,
        passthrough: this.config.env,
      }),
      maxOutputBytes: this.config.maxOutputBytes,
      graceMs: this.config.graceMs,
      ...effectiveSignal !== undefined ? { signal: effectiveSignal } : {},
    }
  }

  /**
   * Run preflight at most once per healthy outcome, and re-probe after a
   * failure — but not immediately.
   *
   * Probing costs a real profile launch, so a model retrying `delegate` against
   * a broken install would pay it on every attempt. A failed result is held for
   * `preflightRetryMs` and answered from cache; after that the next call probes
   * again, so an operator who fixes the install does not have to restart
   * anything. A probe that REJECTS (as opposed to reporting not-ready) is not
   * cached at all: it produced no diagnosis worth repeating.
   */
  private preflight(options?: DelegationCallOptions): Promise<PreflightState> {
    if (
      this.preflightFailedAt !== undefined
      && Date.now() - this.preflightFailedAt >= this.config.preflightRetryMs
    ) {
      this.preflightMemo = undefined
      this.preflightFailedAt = undefined
    }
    if (this.preflightMemo === undefined) {
      const memo = this.probe(options)
      memo.then(
        (state) => { if (!state.ready) this.preflightFailedAt = Date.now() },
        () => {
          this.preflightMemo = undefined
          this.preflightFailedAt = undefined
        },
      )
      this.preflightMemo = memo
    }
    return this.preflightMemo
  }

  /**
   * Probe the installed consult: version gate, then readiness, then the profile
   * roster. Every failure mode returns a `ready: false` state with an actionable
   * diagnosis rather than rejecting — a missing consult must not take the
   * plugin down with it.
   */
  private async probe(options?: DelegationCallOptions): Promise<PreflightState> {
    let invocation: ConsultInvocation
    try {
      invocation = await this.invocation(options)
    } catch (error) {
      return {
        ready: false,
        usable: false,
        profiles: [],
        canReport: false,
        canSteer: false,
        activeFromEarlierSessions: 0,
        diagnosis: `could not resolve the consult executable ${JSON.stringify(this.config.consultPath)}: `
          + `${error instanceof Error ? error.message : String(error)}. Install consult, or set the plugin's \`consultPath\`.`,
      }
    }

    let versionRun
    try {
      versionRun = await runConsult(this.spawn, ['--version'], invocation)
    } catch (error) {
      return {
        ready: false,
        usable: false,
        profiles: [],
        canReport: false,
        canSteer: false,
        activeFromEarlierSessions: 0,
        diagnosis: `could not run \`consult --version\`: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (versionRun.exitCode !== 0) {
      // consult grew `--version` in 1.0; an install that rejects the flag is
      // almost always a pre-1.0 one, which this plugin cannot read anyway.
      const output = (versionRun.stderr.trim().length > 0 ? versionRun.stderr : versionRun.stdout).trim().split('\n')[0] ?? ''
      return {
        ready: false,
        usable: false,
        profiles: [],
        canReport: false,
        canSteer: false,
        activeFromEarlierSessions: 0,
        diagnosis: `\`${this.config.consultPath} --version\` exited ${versionRun.exitCode ?? 'by signal'} (${output.slice(0, 200)}). `
          + 'consult only accepts `--version` from 1.0 onwards, so this is most likely a pre-1.0 install; '
          + 'this plugin supports >=1.0.0 <2.0.0. Upgrade consult, or point the plugin\'s `consultPath` at a 1.x install.',
      }
    }
    const gate = gateConsultVersion(versionRun.stdout)
    if (!gate.ok) {
      return { ready: false, usable: false, profiles: [], canReport: false, canSteer: false, activeFromEarlierSessions: 0, ...gate.version !== undefined ? { version: gate.version } : {}, diagnosis: gate.reason }
    }

    // Doctor checks ONE authority, and it defaults to consult's own
    // (read-only, confined). Probing that instead of the authority this
    // deployment is configured for rejects a perfectly working install for a
    // check it never performs — an `inherit` deployment against a profile
    // consult never confines is the standard case.
    const doctorArgs = [
      'doctor',
      '--json',
      this.config.defaultMode === 'write' ? '--write' : '--read-only',
      '--sandbox',
      this.config.sandbox,
    ]
    const doctorRun = await runConsult(this.spawn, doctorArgs, invocation).catch(() => undefined)
    if (doctorRun === undefined) {
      return { ready: false, usable: true, version: gate.version, profiles: [], canReport: false, canSteer: false, activeFromEarlierSessions: 0, diagnosis: 'could not run `consult doctor --json`' }
    }
    const doctor = parseDoctorReport(doctorRun.stdout, doctorRun.stderr)
    const roster = await this.probeProfiles(invocation)
    const [canReport, canSteer] = await Promise.all([
      this.probeCommand(invocation, 'events'),
      this.probeCommand(invocation, 'steer'),
    ])
    if (!doctor.canDelegate) {
      return {
        ready: false,
        usable: true,
        version: gate.version,
        profiles: roster.profiles,
        canReport,
        canSteer,
        activeFromEarlierSessions: 0,
        ...roster.defaultProfile !== undefined ? { defaultProfile: roster.defaultProfile } : {},
        diagnosis: `consult cannot delegate right now — ${doctor.diagnosis ?? 'no diagnosis reported'}. `
          + 'Run `consult doctor` in the workspace, and `consult setup --install <profile>` if no profile is configured.',
      }
    }
    const defaultProfile = doctor.selectedProfile ?? roster.defaultProfile ?? this.config.defaultProfile
    return {
      ready: true,
      usable: true,
      version: gate.version,
      profiles: roster.profiles,
      canReport,
      canSteer,
      activeFromEarlierSessions: await this.reconcile(invocation),
      ...defaultProfile !== undefined ? { defaultProfile } : {},
    }
  }

  /**
   * Look at what this workspace was already doing before we arrived.
   *
   * Delegation state is durable and outlives the host that started it, so a
   * host that crashed leaves its delegations running with nobody listening.
   * This runs inside the successful preflight, which is BEFORE this session has
   * delegated anything — so every active job it finds necessarily belongs to an
   * earlier session, and no bookkeeping is needed to tell them apart. That
   * timing is the whole argument; move this call after a delegation and the
   * count silently starts including our own work.
   *
   * It surfaces and does not reap: nothing here cancels, adopts, or otherwise
   * touches another session's work. The supervisor decides.
   *
   * The pass also sweeps stale broker records opportunistically. Every failure
   * is swallowed, including the command not existing: a reconciliation that
   * cannot complete must never be the reason delegation is unavailable.
   * @param invocation - the resolved executable, directory, environment, and budgets.
   * @returns how many delegations were already active, or 0 when it could not tell.
   */
  private async reconcile(invocation: ConsultInvocation): Promise<number> {
    let active = 0
    const run = await runConsult(this.spawn, ['status', '--all', '--json'], invocation).catch(() => undefined)
    if (run !== undefined && run.exitCode === 0) {
      try {
        active = countActiveDelegations(parseJobCollection(run.stdout).map(projectJob))
      } catch {
        // An unreadable listing is not a reason to fail preflight; a supervisor
        // that is told nothing is no worse off than before this pass existed.
        active = 0
      }
    }
    // Broker processes already self-terminate; this only removes their stale
    // records. Fire and forget, including against a consult that has no such
    // command.
    await runConsult(this.spawn, ['brokers', '--cleanup'], invocation).catch(() => undefined)
    return active
  }

  /**
   * Decide whether this consult exposes one optional command.
   *
   * The probe is the command's own `--help`: it exits 0 when the command exists
   * and 2 when the subcommand is unknown, which is exactly the distinction
   * being made. It touches no job, no workspace state, and no profile — unlike
   * `doctor`, running it costs nothing but a process. Version numbers cannot
   * answer this question: `report`/`events` and `steer` all landed after 1.0.0
   * was cut, so two builds both reporting 1.0.0 differ on them.
   * @param invocation - the resolved executable, directory, environment, and budgets.
   * @param command - the consult subcommand to probe for.
   * @returns whether the command exists.
   */
  private async probeCommand(invocation: ConsultInvocation, command: string): Promise<boolean> {
    const run = await runConsult(this.spawn, [command, '--help'], invocation).catch(() => undefined)
    return run?.exitCode === 0
  }

  /** Best-effort profile roster; `agents --json` is unversioned, so a failure is not fatal. */
  private async probeProfiles(invocation: ConsultInvocation): Promise<{ profiles: string[]; defaultProfile?: string }> {
    const run = await runConsult(this.spawn, ['agents', '--json'], invocation).catch(() => undefined)
    if (run === undefined || run.exitCode !== 0) return { profiles: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(run.stdout.trim())
    } catch {
      return { profiles: [] }
    }
    if (!Array.isArray(parsed)) return { profiles: [] }
    const profiles: string[] = []
    let defaultProfile: string | undefined
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      if (typeof record.id !== 'string') continue
      profiles.push(record.id)
      if (record.default === true) defaultProfile = record.id
    }
    return { profiles, ...defaultProfile !== undefined ? { defaultProfile } : {} }
  }

  /** Fail every seam call with one actionable `not-ready` message while preflight says so. */
  private async ensureReady(options?: DelegationCallOptions): Promise<PreflightState> {
    const state = await this.preflight(options)
    if (!state.ready) {
      throw new DelegationError('not-ready', 'delegation is unavailable', {
        ...state.diagnosis !== undefined ? { detail: state.diagnosis } : {},
      })
    }
    return state
  }

  override async capabilities(options?: DelegationCallOptions): Promise<DelegationCapabilities> {
    const state = await this.preflight(options)
    return {
      ready: state.ready,
      ...state.version !== undefined ? { version: state.version } : {},
      profiles: state.profiles,
      ...state.defaultProfile !== undefined ? { defaultProfile: state.defaultProfile } : {},
      canSteer: state.canSteer,
      canReport: state.canReport,
      ...state.activeFromEarlierSessions > 0 ? { activeFromEarlierSessions: state.activeFromEarlierSessions } : {},
      ...state.diagnosis !== undefined ? { diagnosis: state.diagnosis } : {},
    }
  }

  override async delegate(spec: DelegateSpec, options?: DelegationCallOptions): Promise<DelegationJob> {
    if (spec.prompt.trim().length === 0) {
      throw new DelegationError('unsupported', 'a delegation prompt must be non-empty')
    }
    await this.ensureReady(options)
    const args = delegateArgs(spec, {
      mode: this.config.defaultMode,
      sandbox: this.config.sandbox,
      profile: this.config.defaultProfile,
    })
    const run = await runConsultWithRetry(this.spawn, args, await this.invocation(options))
    const error = mapExit(run, { command: 'delegate' })
    if (error !== undefined) throw error
    return projectJob(parseJobEnvelope(run.stdout))
  }

  override async review(spec: ReviewSpec, options?: DelegationCallOptions): Promise<DelegationJob> {
    await this.ensureReady(options)
    const args = reviewArgs(spec, { sandbox: this.config.sandbox, profile: this.config.defaultProfile })
    const run = await runConsultWithRetry(this.spawn, args, await this.invocation(options))
    const error = mapExit(run, { command: 'review' })
    if (error !== undefined) throw error
    return projectJob(parseJobEnvelope(run.stdout))
  }

  override async status(id?: DelegationJobId, options?: DelegationCallOptions): Promise<DelegationJob[]> {
    await this.ensureReady(options)
    const args = id === undefined ? ['status', '--json'] : ['status', id, '--json']
    const run = await runConsultWithRetry(this.spawn, args, await this.invocation(options))
    const error = mapExit(run, { command: 'status', jobId: id })
    if (error !== undefined) throw error
    return parseJobCollection(run.stdout).map(projectJob)
  }

  override async wait(
    ids: readonly DelegationJobId[],
    timeoutMs: number,
    options?: DelegationCallOptions,
  ): Promise<DelegationResult[]> {
    if (ids.length === 0) return []
    await this.ensureReady(options)
    // consult's own wait deadline is 30 minutes with no flag to shorten it, so
    // the caller's bound is enforced here and reported as the same `timeout`
    // domain failure consult's exit 4 maps to.
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = options?.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
    const invocation = await this.invocation(options, signal)
    const run = await runConsultWithRetry(this.spawn, ['wait', ...ids, '--json', '--keep-running'], invocation)
    if (run.exitCode !== 0 && deadline.aborted) {
      throw new DelegationError('timeout', `waiting for ${ids.join(', ')} exceeded ${timeoutMs}ms; the delegation is still running`, {
        ...ids[0] !== undefined ? { jobId: ids[0] } : {},
      })
    }
    const error = mapExit(run, { command: 'wait', jobId: ids.length === 1 ? ids[0] : undefined })
    if (error !== undefined) throw error
    return parseJobCollection(run.stdout).map((envelope) => projectResult(envelope, this.config.maxTextBytes))
  }

  override async result(id: DelegationJobId, options?: DelegationCallOptions): Promise<DelegationResult> {
    await this.ensureReady(options)
    const run = await runConsultWithRetry(this.spawn, ['result', id, '--json'], await this.invocation(options))
    const error = mapExit(run, { command: 'result', jobId: id })
    if (error !== undefined) throw error
    return projectResult(parseJobEnvelope(run.stdout), this.config.maxTextBytes)
  }

  override async logs(id: DelegationJobId, tail?: number, options?: DelegationCallOptions): Promise<string> {
    await this.ensureReady(options)
    const lines = tail ?? this.config.logTailLines
    const run = await runConsultWithRetry(this.spawn, ['logs', id, '--tail', String(lines)], await this.invocation(options))
    const error = mapExit(run, { command: 'logs', jobId: id })
    if (error !== undefined) throw error
    return boundLines(run.stdout, lines, this.config.maxTextBytes).text
  }

  override async cancel(id: DelegationJobId, options?: DelegationCallOptions): Promise<void> {
    await this.ensureReady(options)
    const run = await runConsultWithRetry(this.spawn, ['cancel', id], await this.invocation(options))
    const error = mapExit(run, { command: 'cancel', jobId: id })
    if (error !== undefined) throw error
  }

  override async steer(id: DelegationJobId, guidance: string, options?: DelegationCallOptions): Promise<SteerOutcome> {
    // Rejected, never trimmed: a clipped instruction changes what the
    // delegation is being told to do. Checked before spawning so an oversized
    // guidance fails as the argument error it is.
    const bytes = Buffer.byteLength(guidance, 'utf8')
    if (bytes > MAX_STEER_GUIDANCE_BYTES) {
      throw new Error(`guidance is ${bytes} bytes; the limit is ${MAX_STEER_GUIDANCE_BYTES}. Shorten it — consult rejects oversized guidance rather than trimming it.`)
    }
    if (guidance.trim().length === 0) throw new Error('guidance must be a non-empty string')
    // Steering an existing delegation is observation-grade, like reading its
    // events: it needs a usable binary with the command, not the ability to
    // start new delegations.
    const state = await this.preflight(options)
    if (!state.usable) {
      throw new DelegationError('not-ready', 'delegation is unavailable', {
        ...state.diagnosis !== undefined ? { detail: state.diagnosis } : {},
      })
    }
    if (!state.canSteer) return { supported: false, reason: STEER_UNSUPPORTED }
    // Deliberately NOT runConsultWithRetry: exit 3 means a steer is already in
    // flight, and delivering a second interruption of the same turn is worse
    // than reporting that this one did not land.
    const run = await runConsult(this.spawn, steerArgs(id, guidance), await this.invocation(options))
    const outcome = mapSteerExit(run, id)
    if (outcome instanceof Error) throw outcome
    return outcome
  }

  override async events(
    id: DelegationJobId,
    fromSeq?: number,
    options?: DelegationCallOptions,
  ): Promise<DelegationEventPage> {
    // Observation is deliberately NOT gated on doctor's canDelegate. Reading a
    // delegation's events needs a usable consult binary and nothing else; a
    // supervisor whose profile configuration broke while a delegation was in
    // flight must not go blind to what that delegation is reporting.
    const state = await this.preflight(options)
    if (!state.usable) {
      throw new DelegationError('not-ready', 'delegation is unavailable', {
        ...state.diagnosis !== undefined ? { detail: state.diagnosis } : {},
      })
    }
    if (!state.canReport) return { supported: false, events: [], reason: EVENTS_UNSUPPORTED }
    const args = eventsArgs(id, { ...fromSeq !== undefined ? { sinceSeq: fromSeq } : {} })
    const run = await runConsultWithRetry(this.spawn, args, await this.invocation(options))
    const error = mapExit(run, { command: 'events', jobId: id })
    if (error !== undefined) throw error
    const events = parseEventsEnvelope(run.stdout, this.config.maxTextBytes)
    const nextSeq = events.reduce((highest, event) => Math.max(highest, event.seq ?? 0), fromSeq ?? 0)
    return { supported: true, events, ...nextSeq > 0 ? { nextSeq } : {} }
  }

  override watch(
    id: DelegationJobId,
    listener: (event: DelegationEvent) => void,
    options?: DelegationCallOptions,
  ): () => void {
    // A follow outlives the call that asked for it, so the caller's per-call
    // signal is deliberately dropped: cancelling a tool call must not blind the
    // supervisor to a delegation that is still running.
    const { signal: _callSignal, ...followOptions } = options ?? {}
    let watch = this.watches.get(id)
    // A watch that already reached its terminal transition (or was closed) is a
    // spent record, not a subscription to join: attaching to it would add a
    // listener nothing will ever call, because its follow process is gone and
    // no new one starts. Retire it and follow again from scratch.
    if (watch !== undefined && (watch.closed || watch.finished)) {
      this.closeWatch(id, watch)
      watch = undefined
    }
    if (watch === undefined) {
      watch = {
        listeners: new Set(),
        options: followOptions,
        lastSeq: 0,
        finished: false,
        closed: false,
        handle: undefined,
        restart: undefined,
        barrenRestarts: 0,
        release: undefined,
      }
      this.watches.set(id, watch)
      // Preflight is async and `watch` is not, so the follow starts on the
      // capability answer rather than blocking on it. A consult without the
      // events command never spawns anything.
      const starting = watch
      void this.preflight(options).then((state) => {
        // Same reasoning as events(): a usable binary with the events command
        // is the whole requirement for following a delegation already running.
        if (state.usable && state.canReport && !starting.closed) this.startFollow(id, starting)
        else this.closeWatch(id, starting)
      }, () => this.closeWatch(id, starting))
    }
    const active = watch
    active.listeners.add(listener)
    let released = false
    return () => {
      if (released) return
      released = true
      active.listeners.delete(listener)
      if (active.listeners.size === 0) this.closeWatch(id, active)
    }
  }

  override onEvent(listener: (event: DelegationEvent) => void): () => void {
    this.observers.add(listener)
    let released = false
    return () => {
      if (released) return
      released = true
      this.observers.delete(listener)
    }
  }

  /**
   * Spawn one `consult events <id> --follow --json` and stream its NDJSON.
   *
   * The process is owned by a `ctx.effect`, so plugin disposal kills it even
   * if nothing unsubscribes. It ends on its own when the job finalizes (exit
   * 0 after the terminal transition); a death while the job is still live —
   * consult's own 30-minute follow deadline (exit 4), or anything else —
   * restarts from `--since <lastSeq>` so no report is delivered twice and none
   * is lost. Restarts that never produce an event are bounded, because a
   * broken install must not become a respawn loop.
   */
  private startFollow(id: DelegationJobId, watch: Watch): void {
    if (watch.closed || watch.finished) return
    void (async () => {
      let invocation: ConsultInvocation
      try {
        // `watch.options` already had the caller's signal stripped; the follow
        // owns its own lifetime through ctx.effect and closeWatch().
        invocation = await this.invocation(watch.options)
      } catch {
        this.closeWatch(id, watch)
        return
      }
      if (watch.closed || watch.finished) return
      const handle = this.spawn({
        argv: [...invocation.command, ...eventsArgs(id, { follow: true, sinceSeq: watch.lastSeq })],
        cwd: invocation.cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4_096 } },
        graceMs: invocation.graceMs,
        env: invocation.env,
      })
      watch.handle = handle
      watch.release = this.ctx.effect(() => () => handle.terminate())
      let produced = false
      let buffer = ''
      const consume = (chunk: string, flush: boolean): void => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = flush ? '' : lines.pop() ?? ''
        for (const line of lines) {
          const event = parseEventLine(line, this.config.maxTextBytes)
          if (event === undefined) continue
          produced = true
          if (event.seq !== undefined) watch.lastSeq = Math.max(watch.lastSeq, event.seq)
          if (event.type === 'lifecycle' && event.lifecycle?.phase === 'terminal') watch.finished = true
          this.emit(watch, event)
        }
      }
      handle.stdout?.setEncoding('utf8')
      handle.stdout?.on('data', (chunk: string) => consume(chunk, false))
      const outcome = await handle.done.catch(() => undefined)
      consume('', true)
      watch.handle = undefined
      watch.release?.()
      watch.release = undefined
      if (watch.closed || watch.finished) {
        this.closeWatch(id, watch)
        return
      }
      // Exit 2 means the job is unknown to consult: retrying cannot help.
      if (outcome?.exitCode === 2) {
        this.closeWatch(id, watch)
        return
      }
      watch.barrenRestarts = produced ? 0 : watch.barrenRestarts + 1
      if (watch.barrenRestarts > MAX_BARREN_FOLLOW_RESTARTS) {
        this.closeWatch(id, watch)
        return
      }
      watch.restart = setTimeout(() => {
        watch.restart = undefined
        this.startFollow(id, watch)
      }, this.config.eventFollowRestartMs)
      watch.restart.unref?.()
    })()
  }

  /** Deliver one event to this job's listeners and to every global observer, containing listener throws. */
  private emit(watch: Watch, event: DelegationEvent): void {
    for (const listener of [...watch.listeners, ...this.observers]) {
      try {
        listener(event)
      } catch {
        // A listener that throws must not tear down the follow it is watching.
      }
    }
  }

  /** Stop one follow and forget it. Idempotent. */
  private closeWatch(id: DelegationJobId, watch: Watch): void {
    watch.closed = true
    watch.listeners.clear()
    if (watch.restart !== undefined) {
      clearTimeout(watch.restart)
      watch.restart = undefined
    }
    watch.handle?.terminate()
    watch.handle = undefined
    watch.release?.()
    watch.release = undefined
    if (this.watches.get(id) === watch) this.watches.delete(id)
  }
}

export default ConsultDelegation
