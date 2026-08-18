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
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  boundLines,
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
  runConsult,
  runConsultWithRetry,
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
   * Reserved for M4 event delivery: how many supervisor turns delegation events
   * may open before degrading to injection. Completion notices in M1 are
   * delivered by `@deepseek-ai/dsh-tool-jobs`, which owns its own
   * `maxConsecutiveWakes` budget; this field does not override it.
   */
  wakeBudget?: number
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
  version?: string
  profiles: string[]
  defaultProfile?: string
  diagnosis?: string
}

const STEER_UNSUPPORTED = 'consult 1.x has no steer command. Cancel the job and re-delegate with the corrected prompt; '
  + 'native steering arrives with dsh-consult M3.'
const EVENTS_UNSUPPORTED = 'consult 1.x has no upward event stream. Read progress with delegate_logs; '
  + 'typed delegation events arrive with dsh-consult M4.'

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
    wakeBudget: z.number().min(1).default(3),
    graceMs: z.number().min(1).default(5_000),
    env: z.dict(z.string()),
  })

  readonly config: ResolvedConfig

  private commandMemo: Promise<string[]> | undefined
  private preflightMemo: Promise<PreflightState> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
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

  /** Run preflight at most once per healthy outcome; re-probe after any failure. */
  private preflight(options?: DelegationCallOptions): Promise<PreflightState> {
    if (this.preflightMemo === undefined) {
      const memo = this.probe(options)
      memo.then(
        (state) => { if (!state.ready) this.preflightMemo = undefined },
        () => { this.preflightMemo = undefined },
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
        profiles: [],
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
        profiles: [],
        diagnosis: `could not run \`consult --version\`: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (versionRun.exitCode !== 0) {
      // consult grew `--version` in 1.0; an install that rejects the flag is
      // almost always a pre-1.0 one, which this plugin cannot read anyway.
      const output = (versionRun.stderr.trim().length > 0 ? versionRun.stderr : versionRun.stdout).trim().split('\n')[0] ?? ''
      return {
        ready: false,
        profiles: [],
        diagnosis: `\`${this.config.consultPath} --version\` exited ${versionRun.exitCode ?? 'by signal'} (${output.slice(0, 200)}). `
          + 'consult only accepts `--version` from 1.0 onwards, so this is most likely a pre-1.0 install; '
          + 'this plugin supports >=1.0.0 <2.0.0. Upgrade consult, or point the plugin\'s `consultPath` at a 1.x install.',
      }
    }
    const gate = gateConsultVersion(versionRun.stdout)
    if (!gate.ok) {
      return { ready: false, profiles: [], ...gate.version !== undefined ? { version: gate.version } : {}, diagnosis: gate.reason }
    }

    const doctorRun = await runConsult(this.spawn, ['doctor', '--json'], invocation).catch(() => undefined)
    if (doctorRun === undefined) {
      return { ready: false, version: gate.version, profiles: [], diagnosis: 'could not run `consult doctor --json`' }
    }
    const doctor = parseDoctorReport(doctorRun.stdout, doctorRun.stderr)
    const roster = await this.probeProfiles(invocation)
    if (!doctor.canDelegate) {
      return {
        ready: false,
        version: gate.version,
        profiles: roster.profiles,
        ...roster.defaultProfile !== undefined ? { defaultProfile: roster.defaultProfile } : {},
        diagnosis: `consult cannot delegate right now — ${doctor.diagnosis ?? 'no diagnosis reported'}. `
          + 'Run `consult doctor` in the workspace, and `consult setup --install <profile>` if no profile is configured.',
      }
    }
    const defaultProfile = doctor.selectedProfile ?? roster.defaultProfile ?? this.config.defaultProfile
    return {
      ready: true,
      version: gate.version,
      profiles: roster.profiles,
      ...defaultProfile !== undefined ? { defaultProfile } : {},
    }
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
      canSteer: false,
      canReport: false,
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

  override steer(_id: DelegationJobId, _guidance: string, _options?: DelegationCallOptions): Promise<SteerOutcome> {
    return Promise.resolve({ supported: false, reason: STEER_UNSUPPORTED })
  }

  override events(_id: DelegationJobId, _fromSeq?: number, _options?: DelegationCallOptions): Promise<DelegationEventPage> {
    return Promise.resolve({ supported: false, events: [], reason: EVENTS_UNSUPPORTED })
  }

  override onEvent(_listener: (event: DelegationEvent) => void): () => void {
    // No push channel exists yet; the subscription is a well-typed no-op so a
    // consumer written against M4 loads unchanged against M1.
    return () => {}
  }
}

export default ConsultDelegation
