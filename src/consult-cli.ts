/**
 * The consult CLI adapter, expressed as dependency-injected functions over one
 * `spawn` callable rather than as methods on the Service. Everything here is
 * testable without a Cordis context: argv construction, environment injection,
 * the schema-version-1 envelope parse and projection, exit-code mapping, the
 * semver preflight gate, and output bounding. `provider.ts` is the thin Service
 * shell that supplies `ctx.subprocess.spawn` and the resolved config.
 *
 * The CLI is the whole contract. Nothing here reads consult's private state
 * directory; the only paths this module touches are the ones an envelope hands
 * back.
 * @module @aubwang/dsh-consult/consult-cli
 */

import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  DelegationError,
  type DelegateSpec,
  type DelegationArtifacts,
  type DelegationEvent,
  type DelegationJob,
  type DelegationJobId,
  type DelegationLifecycle,
  type DelegationLineage,
  type DelegationMode,
  type DelegationResult,
  type DelegationSandbox,
  type DelegationStatus,
  type ReviewSpec,
  type SteerOutcome,
} from './seam.ts'

/** The one process primitive this adapter needs; `ctx.subprocess.spawn` satisfies it. */
export type ConsultSpawn = (spec: SubprocessSpawnSpec) => SubprocessHandle

/** Everything one consult invocation needs beyond its arguments. */
export interface ConsultInvocation {
  /** Executable plus any fixed leading arguments (e.g. `['node', '/path/bin/consult']`). */
  command: readonly string[]
  cwd: string
  /** Explicit environment layered onto the subprocess service's scrubbed base. */
  env: Record<string, string>
  /** Per-stream in-memory cap; overflow keeps the tail. */
  maxOutputBytes: number
  /** SIGTERM→SIGKILL grace, also the drain window for collected pipes. */
  graceMs: number
  signal?: AbortSignal | undefined
}

/** One completed consult invocation. */
export interface ConsultRun {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** True when either stream lost bytes to its in-memory cap. */
  truncated: boolean
}

/** consult's documented exit-code contract. */
export const CONSULT_EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  contention: 3,
  timeout: 4,
  notFinal: 5,
  delegateFailed: 6,
  nativeReviewUnsupported: 8,
} as const

/** The only job-envelope schema version this plugin trusts. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Accepted consult CLI range: `>=1.0.0 <2.0.0`. */
export const SUPPORTED_CONSULT_MAJOR = 1

/**
 * Spawn one consult invocation and collect its bounded output.
 * @param spawn - the subprocess seam's spawn callable.
 * @param args - arguments after {@link ConsultInvocation.command}.
 * @param invocation - executable, directory, environment, and budgets.
 * @returns exit facts plus both collected streams.
 */
export async function runConsult(
  spawn: ConsultSpawn,
  args: readonly string[],
  invocation: ConsultInvocation,
): Promise<ConsultRun> {
  const handle = spawn({
    argv: [...invocation.command, ...args],
    cwd: invocation.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: invocation.maxOutputBytes },
      stderr: { maxBytes: invocation.maxOutputBytes },
    },
    graceMs: invocation.graceMs,
    ...invocation.signal !== undefined ? { signal: invocation.signal } : {},
    env: invocation.env,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
    truncated: (stdout?.lossy ?? false) || (stderr?.lossy ?? false),
  }
}

/**
 * Run one invocation, retrying exactly once on consult's contention exit (3).
 * Contention is a broker that is momentarily busy or tainted; a single bounded
 * retry is the whole policy — this plugin never loops on a delegate's behalf.
 * @param spawn - the subprocess seam's spawn callable.
 * @param args - arguments after the command prefix.
 * @param invocation - executable, directory, environment, and budgets.
 * @returns the last run performed.
 */
export async function runConsultWithRetry(
  spawn: ConsultSpawn,
  args: readonly string[],
  invocation: ConsultInvocation,
): Promise<ConsultRun> {
  const first = await runConsult(spawn, args, invocation)
  if (first.exitCode !== CONSULT_EXIT.contention) return first
  if (invocation.signal?.aborted === true) return first
  return runConsult(spawn, args, invocation)
}

/** Managed environment facts every consult invocation carries. */
export interface ConsultEnvInputs {
  /** Calling agent's session id; scopes provider-side job records. */
  hostSessionId?: string | undefined
  /** Relocates consult's state directory. */
  dataDir?: string | undefined
  /** Deployment-configured passthrough (credentials the subprocess scrub strips). */
  passthrough?: Readonly<Record<string, string>> | undefined
}

/**
 * Build the explicit environment for one consult invocation. Configured
 * passthrough is layered FIRST so the plugin-managed host identity always wins:
 * a deployment can forward `ANTHROPIC_API_KEY` past the subprocess credential
 * scrub without being able to spoof which host session a job belongs to.
 * @param inputs - host session, data directory, and configured passthrough.
 * @returns the explicit env map for {@link SubprocessSpawnSpec.env}.
 */
export function buildConsultEnv(inputs: ConsultEnvInputs): Record<string, string> {
  const env: Record<string, string> = { ...inputs.passthrough }
  env.CONSULT_HOST = 'dsh'
  if (inputs.hostSessionId !== undefined && inputs.hostSessionId.length > 0) {
    env.CONSULT_HOST_SESSION_ID = inputs.hostSessionId
  }
  if (inputs.dataDir !== undefined && inputs.dataDir.length > 0) {
    env.CONSULT_DATA_DIR = inputs.dataDir
  }
  return env
}

/** Outcome of the CLI semver gate. */
export type VersionGate =
  | { ok: true; version: string }
  | { ok: false; version?: string; reason: string }

/**
 * Gate the installed consult CLI at `>=1.0.0 <2.0.0`. A stale 0.x install is
 * the expected failure here: its JSON is not the schema-version-1 envelope this
 * plugin parses, so refusing loudly beats mis-parsing quietly.
 * @param raw - stdout of `consult --version`.
 * @returns the accepted version, or an actionable refusal.
 */
export function gateConsultVersion(raw: string): VersionGate {
  const match = /(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/.exec(raw.trim())
  if (match === null) {
    return { ok: false, reason: `could not read a version from \`consult --version\` output: ${JSON.stringify(raw.trim().slice(0, 200))}` }
  }
  const version = match[0]
  const major = Number(match[1])
  if (major !== SUPPORTED_CONSULT_MAJOR) {
    return {
      ok: false,
      version,
      reason: `consult ${version} is outside the supported range >=1.0.0 <2.0.0. `
        + 'Point `consultPath` at a 1.x install, or upgrade the consult on PATH.',
    }
  }
  return { ok: true, version }
}

/** The subset of consult's `doctor --json` report this plugin depends on. */
export interface DoctorSummary {
  canDelegate: boolean
  selectedProfile?: string
  /** Bounded human diagnosis assembled from the failing sections. */
  diagnosis?: string
}

/**
 * Defensively parse `consult doctor --json`. The doctor report is NOT a
 * versioned contract, so every field is optional and a parse failure degrades
 * to "not ready" with the raw text rather than throwing.
 * @param stdout - doctor's JSON output.
 * @param stderr - doctor's diagnostics, used when stdout is unusable.
 * @returns the readiness summary.
 */
export function parseDoctorReport(stdout: string, stderr: string): DoctorSummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    const text = (stderr.trim().length > 0 ? stderr : stdout).trim()
    return { canDelegate: false, diagnosis: `consult doctor did not emit JSON: ${text.slice(0, 500)}` }
  }
  if (!isRecord(parsed)) {
    return { canDelegate: false, diagnosis: 'consult doctor emitted JSON that is not an object' }
  }
  const canDelegate = parsed.canDelegate === true
  const profile = isRecord(parsed.profile) ? parsed.profile : undefined
  const selectedProfile = typeof profile?.selectedProfile === 'string' ? profile.selectedProfile : undefined
  if (canDelegate) {
    return { canDelegate, ...selectedProfile !== undefined ? { selectedProfile } : {} }
  }
  const reasons: string[] = []
  for (const section of ['profile', 'jobs', 'brokers', 'authority']) {
    const value = parsed[section]
    if (!isRecord(value) || value.ok === true) continue
    const detail = typeof value.error === 'string' && value.error.length > 0
      ? value.error
      : typeof value.message === 'string' ? value.message : 'not ok'
    const remediation = typeof value.remediation === 'string' ? ` — ${value.remediation}` : ''
    reasons.push(`${section}: ${detail}${remediation}`)
  }
  if (reasons.length === 0) reasons.push('consult doctor reported canDelegate: false without a failing section')
  return {
    canDelegate,
    ...selectedProfile !== undefined ? { selectedProfile } : {},
    diagnosis: reasons.join('; ').slice(0, 1000),
  }
}

/** The schema-version-1 job payload sections this plugin reads. */
export interface JobEnvelope {
  job: Record<string, unknown>
  outcome: Record<string, unknown>
  artifacts: Record<string, unknown>
  lineage: Record<string, unknown>
}

/**
 * Parse one schema-version-1 job envelope. Unknown fields are ignored (the
 * contract evolves additively); a missing or different `schemaVersion` is a
 * hard refusal, because silently reading an unknown shape is how a supervisor
 * ends up acting on invented data.
 * @param stdout - the CLI's `--json` output.
 * @returns the four payload sections.
 * @throws DelegationError `internal` when the output is not a version-1 envelope.
 */
export function parseJobEnvelope(stdout: string): JobEnvelope {
  const parsed = parseJson(stdout)
  return requireEnvelope(parsed)
}

/**
 * Parse a schema-version-1 job collection (`{schemaVersion, jobs: [...]}`),
 * also accepting a single envelope for callers that pass one job id.
 * @param stdout - the CLI's `--json` output.
 * @returns the envelopes in emission order.
 * @throws DelegationError `internal` when the output is not a version-1 collection.
 */
export function parseJobCollection(stdout: string): JobEnvelope[] {
  const parsed = parseJson(stdout)
  if (!isRecord(parsed)) throw internalError('consult --json output was not a JSON object')
  if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw internalError(`unsupported consult JSON schemaVersion ${JSON.stringify(parsed.schemaVersion)}; this plugin reads version ${SUPPORTED_SCHEMA_VERSION}`)
  }
  if (!Array.isArray(parsed.jobs)) return [requireEnvelope(parsed)]
  return parsed.jobs.map((entry, index) => {
    if (!isRecord(entry)) throw internalError(`consult job collection entry ${index} was not an object`)
    return sections(entry)
  })
}

/**
 * Project a job envelope onto the seam's provider-neutral job vocabulary.
 * @param envelope - a parsed schema-version-1 envelope.
 * @returns the seam projection.
 */
export function projectJob(envelope: JobEnvelope): DelegationJob {
  const job = envelope.job
  const id = stringOf(job.id)
  if (id === undefined) throw internalError('consult job envelope carried no job id')
  const rawStatus = stringOf(job.status)
  const status = projectStatus(rawStatus)
  const label = stringOf(job.label)
  const kind = stringOf(job.kind)
  const submittedAt = stringOf(job.submittedAt)
  const finishedAt = stringOf(job.completedAt)
  return {
    id,
    status,
    ...status === 'unknown' && rawStatus !== undefined ? { rawStatus } : {},
    ...label !== undefined ? { label } : {},
    profile: stringOf(job.profile) ?? 'unknown',
    mode: projectMode(job),
    ...kind !== undefined ? { kind } : {},
    ...submittedAt !== undefined ? { submittedAt } : {},
    ...finishedAt !== undefined ? { finishedAt } : {},
  }
}

/**
 * Project a job envelope onto the seam's result vocabulary, bounding every
 * delegate-authored text field on the way out.
 * @param envelope - a parsed schema-version-1 envelope.
 * @param maxTextBytes - byte cap applied to `finalText` and `errorMessage`.
 * @returns the bounded seam projection.
 */
export function projectResult(envelope: JobEnvelope, maxTextBytes: number): DelegationResult {
  const base = projectJob(envelope)
  const finalText = stringOf(envelope.outcome.finalText)
  const errorMessage = stringOf(envelope.outcome.errorMessage)
  const bounded = finalText === undefined ? undefined : boundText(finalText, maxTextBytes, 'head')
  const artifacts = projectArtifacts(envelope.artifacts)
  const lineage = projectLineage(envelope.lineage)
  return {
    ...base,
    ...bounded !== undefined ? { finalText: bounded.text, finalTextTruncated: bounded.truncated } : {},
    ...errorMessage !== undefined ? { errorMessage: boundText(errorMessage, maxTextBytes, 'head').text } : {},
    ...artifacts !== undefined ? { artifacts } : {},
    ...lineage !== undefined ? { lineage } : {},
  }
}

/** Build `consult delegate` arguments from a seam spec. Always background, always `--json`. */
export function delegateArgs(spec: DelegateSpec, defaults: { mode: DelegationMode; sandbox: DelegationSandbox; profile?: string | undefined }): string[] {
  const mode = spec.mode ?? defaults.mode
  const args = ['delegate', '--background', '--json']
  const profile = spec.profile ?? defaults.profile
  if (profile !== undefined) args.push('--agent', profile)
  args.push(mode === 'write' ? '--write' : '--read-only')
  if (spec.isolated === true) {
    if (mode !== 'write') throw new DelegationError('unsupported', 'isolated delegation requires mode "write"')
    args.push('--isolated')
  }
  args.push('--sandbox', spec.sandbox ?? defaults.sandbox)
  if (spec.model !== undefined) args.push('--model', spec.model)
  if (spec.effort !== undefined) args.push('--effort', spec.effort)
  if (spec.label !== undefined) args.push('--label', spec.label)
  for (const after of spec.after ?? []) args.push('--after', after)
  args.push('--', spec.prompt)
  return args
}

/** Build `consult review` arguments from a seam spec. Always background, always `--json`. */
export function reviewArgs(spec: ReviewSpec, defaults: { sandbox: DelegationSandbox; profile?: string | undefined }): string[] {
  if (spec.base !== undefined && spec.jobId !== undefined) {
    throw new DelegationError('unsupported', 'review accepts either a base ref or a job id, not both')
  }
  const args = ['review', '--background', '--json']
  const profile = spec.profile ?? defaults.profile
  if (profile !== undefined) args.push('--agent', profile)
  if (spec.base !== undefined) args.push('--base', spec.base)
  if (spec.jobId !== undefined) args.push('--job', spec.jobId)
  args.push('--sandbox', spec.sandbox ?? defaults.sandbox)
  if (spec.model !== undefined) args.push('--model', spec.model)
  if (spec.effort !== undefined) args.push('--effort', spec.effort)
  if (spec.label !== undefined) args.push('--label', spec.label)
  return args
}

/** Context used when turning a non-zero exit into a domain failure. */
export interface ExitMappingContext {
  /** The consult subcommand, used in messages. */
  command: string
  jobId?: DelegationJobId | undefined
  /** Observed job status, when an envelope was still parseable. */
  status?: DelegationStatus | undefined
}

/**
 * Map one consult exit code onto the seam's failure vocabulary.
 *
 * Exit 2 is deliberately NOT a {@link DelegationError}: consult reports usage,
 * configuration, and unknown-job errors with it, and every argv this plugin
 * builds is plugin-authored, so a 2 means this plugin (or its configuration) is
 * wrong. It throws as an ordinary Error and surfaces as an infrastructure tool
 * failure, exactly as PLAN.md §4 specifies.
 * @param run - the completed invocation.
 * @param context - subcommand and job identity for the message.
 * @returns the error to throw, or undefined when the run succeeded.
 */
export function mapExit(run: ConsultRun, context: ExitMappingContext): Error | undefined {
  if (run.exitCode === CONSULT_EXIT.ok) return undefined
  const detail = firstLines(run.stderr.trim().length > 0 ? run.stderr : run.stdout, 20, 2000)
  const where = context.jobId === undefined ? `consult ${context.command}` : `consult ${context.command} ${context.jobId}`
  const options = {
    ...detail.length > 0 ? { detail } : {},
    ...context.jobId !== undefined ? { jobId: context.jobId } : {},
    ...context.status !== undefined ? { status: context.status } : {},
  }
  if (run.exitCode === null) {
    return new DelegationError('internal', `${where} was killed by signal ${run.signal ?? 'unknown'}`, options)
  }
  switch (run.exitCode) {
    case CONSULT_EXIT.usage:
      return new Error(`${where} failed with a usage or configuration error (exit 2)${detail.length > 0 ? `: ${detail}` : ''}`)
    case CONSULT_EXIT.contention:
      return new DelegationError('busy', `${where} could not proceed: the consult broker is busy or the job payload conflicts (exit 3), and one retry did not clear it`, options)
    case CONSULT_EXIT.timeout:
      return new DelegationError('timeout', `${where} timed out (exit 4); the job is still running`, options)
    case CONSULT_EXIT.notFinal:
      return new DelegationError('not-final', `${where} was requested before the job finalized (exit 5)`, options)
    case CONSULT_EXIT.delegateFailed:
      return new DelegationError('delegate-failed', `${where}: the delegated turn finalized as failed (exit 6)`, options)
    case CONSULT_EXIT.nativeReviewUnsupported:
      return new DelegationError('review-unsupported', `${where}: this profile's installed shim does not advertise a native review command (exit 8)`, options)
    default:
      return new DelegationError('internal', `${where} failed with exit ${run.exitCode}`, options)
  }
}

/**
 * `consult events` carries its own small versioned envelope — it is not a Job
 * Result, so it does not reuse the schema-version-1 job sections even though
 * both happen to be at version 1.
 */
export const SUPPORTED_EVENTS_SCHEMA_VERSION = 1

/**
 * Guidance larger than this is rejected by consult rather than trimmed — a
 * clipped instruction changes what the delegation is being told to do. The
 * plugin enforces the same bound before spawning so an oversized guidance
 * fails as an argument error instead of a process exit.
 */
export const MAX_STEER_GUIDANCE_BYTES = 16 * 1024

/** Report types the delegate itself may emit. Anything else is ignored. */
const REPORT_TYPES = ['blocked', 'decision_needed', 'discovery', 'progress'] as const

/** Report types urgent enough to be worth opening a supervisor turn for. */
const WAKE_TYPES: readonly string[] = ['blocked', 'decision_needed']

/** Lifecycle phases the event stream synthesizes from the job record. */
const LIFECYCLE_PHASES = ['queued', 'running', 'terminal'] as const

/**
 * Count delegations that have not reached a terminal status.
 *
 * Only the two explicitly live statuses count. A status this seam version does
 * not model projects as `unknown`, and guessing that an unrecognized state is
 * still running would inflate a number whose entire purpose is to tell a
 * supervisor something needs its attention.
 * @param jobs - projected job records.
 * @returns how many are queued or running.
 */
export function countActiveDelegations(jobs: readonly DelegationJob[]): number {
  return jobs.filter((job) => job.status === 'queued' || job.status === 'running').length
}

/**
 * Build `consult steer` arguments. The guidance goes through `--message`
 * rather than after `--`, so text that begins with a dash cannot be re-read as
 * a flag by anything downstream.
 */
export function steerArgs(id: DelegationJobId, guidance: string): string[] {
  return ['steer', id, '--message', guidance]
}

/** Build `consult events` arguments. Always `--json`; `--follow` streams NDJSON. */
export function eventsArgs(id: DelegationJobId, options: { follow?: boolean; sinceSeq?: number } = {}): string[] {
  const args = ['events', id, '--json']
  if (options.follow === true) args.push('--follow')
  // `--since` filters the report stream only; lifecycle transitions are always
  // replayed, which is exactly what a reconnecting follower needs.
  if (options.sinceSeq !== undefined && options.sinceSeq > 0) args.push('--since', String(options.sinceSeq))
  return args
}

/**
 * Parse the non-follow events envelope
 * (`{schemaVersion, jobId, events: [...]}`), bounding every delegate-authored
 * field on the way out.
 * @param stdout - the CLI's `--json` output.
 * @param maxTextBytes - byte cap for each event message.
 * @returns the projected events in emission order.
 * @throws DelegationError `internal` when the output is not a version-1 events envelope.
 */
export function parseEventsEnvelope(stdout: string, maxTextBytes: number): DelegationEvent[] {
  const parsed = parseJson(stdout)
  if (!isRecord(parsed)) throw internalError('consult events --json output was not a JSON object')
  if (parsed.schemaVersion !== SUPPORTED_EVENTS_SCHEMA_VERSION) {
    throw internalError(`unsupported consult events schemaVersion ${JSON.stringify(parsed.schemaVersion)}; this plugin reads version ${SUPPORTED_EVENTS_SCHEMA_VERSION}`)
  }
  const jobId = stringOf(parsed.jobId)
  if (jobId === undefined) throw internalError('consult events envelope carried no job id')
  if (!Array.isArray(parsed.events)) throw internalError('consult events envelope carried no events array')
  const events: DelegationEvent[] = []
  for (const entry of parsed.events) {
    const event = projectEvent(entry, jobId, maxTextBytes)
    if (event !== undefined) events.push(event)
  }
  return events
}

/**
 * Parse one NDJSON line from `consult events --follow --json`.
 *
 * A follow stream is read while it is being written, so a malformed or partial
 * line is an ordinary occurrence rather than a contract violation: it is
 * dropped, and the caller keeps reading. Only the framing version is enforced.
 * @param line - one complete line from the follow stream.
 * @param maxTextBytes - byte cap for the event message.
 * @returns the projected event, or undefined when the line carries none.
 */
export function parseEventLine(line: string, maxTextBytes: number): DelegationEvent | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== SUPPORTED_EVENTS_SCHEMA_VERSION) return undefined
  const jobId = stringOf(parsed.jobId)
  if (jobId === undefined) return undefined
  return projectEvent(parsed.event, jobId, maxTextBytes)
}

/**
 * Project one raw consult event onto the seam vocabulary.
 *
 * Urgency is decided here, by type, because it is a property of what the
 * delegate said rather than of who is listening: `blocked` and
 * `decision_needed` mean the delegation cannot progress without the
 * supervisor, so they are worth a turn; `discovery` and `progress` are worth
 * reading on the next step. Lifecycle transitions are informational — the
 * jobs runtime already announces completion.
 * @param raw - one entry from an events envelope or follow line.
 * @param jobId - the delegation the event belongs to.
 * @param maxTextBytes - byte cap for the event message.
 * @returns the projected event, or undefined for an unrecognized shape.
 */
export function projectEvent(raw: unknown, jobId: DelegationJobId, maxTextBytes: number): DelegationEvent | undefined {
  if (!isRecord(raw)) return undefined
  const at = stringOf(raw.at) ?? ''
  const type = stringOf(raw.type)
  if (type === undefined) return undefined
  if (raw.kind === 'lifecycle') {
    if (!(LIFECYCLE_PHASES as readonly string[]).includes(type)) return undefined
    const phase = type as DelegationLifecycle['phase']
    const status = phase === 'terminal' ? projectStatus(stringOf(raw.status)) : undefined
    const errorMessage = stringOf(raw.errorMessage)
    return {
      jobId,
      at,
      type: 'lifecycle',
      urgency: 'info',
      message: phase === 'terminal' ? `delegation ${jobId} ${status ?? 'ended'}` : `delegation ${jobId} ${phase}`,
      lifecycle: {
        phase,
        ...status !== undefined ? { status } : {},
        ...errorMessage !== undefined ? { errorMessage: boundText(errorMessage, maxTextBytes, 'head').text } : {},
      },
    }
  }
  if (raw.kind === 'steer') {
    // The supervisor's own guidance, echoed back with a bounded preview. It
    // shares the report sequence space, so a resuming reader must not be able
    // to skip a steer by having read past it.
    const seq = typeof raw.seq === 'number' && Number.isSafeInteger(raw.seq) ? raw.seq : undefined
    return {
      jobId,
      ...seq !== undefined ? { seq } : {},
      at,
      type: 'steer',
      urgency: 'info',
      message: boundText(typeof raw.message === 'string' ? raw.message : '', maxTextBytes, 'head').text,
    }
  }
  if (raw.kind !== 'report') return undefined
  if (!(REPORT_TYPES as readonly string[]).includes(type)) return undefined
  const seq = typeof raw.seq === 'number' && Number.isSafeInteger(raw.seq) ? raw.seq : undefined
  const message = typeof raw.message === 'string' ? raw.message : ''
  return {
    jobId,
    ...seq !== undefined ? { seq } : {},
    at,
    type: type as 'blocked' | 'decision_needed' | 'discovery' | 'progress',
    urgency: WAKE_TYPES.includes(type) ? 'wake' : 'info',
    message: boundText(message, maxTextBytes, 'head').text,
    ...raw.data !== undefined ? { data: boundJson(raw.data, maxTextBytes) } : {},
  }
}

/**
 * Bound a structured event payload by re-encoding it and, when it does not
 * fit, replacing it with the bounded text of its own encoding — a supervisor
 * that cannot have the whole object is better served by a readable prefix than
 * by a silently pruned object it might reason about as complete.
 * @param data - the delegate-authored payload.
 * @param maxBytes - byte budget for its JSON encoding.
 * @returns the payload, or a bounded string standing in for it.
 */
export function boundJson(data: unknown, maxBytes: number): unknown {
  let encoded: string
  try {
    encoded = JSON.stringify(data) ?? 'null'
  } catch {
    return '[unencodable delegate data]'
  }
  if (Buffer.byteLength(encoded, 'utf8') <= maxBytes) return data
  return boundText(encoded, maxBytes, 'head').text
}

/**
 * Map one `consult steer` exit onto the seam's steer vocabulary.
 *
 * The three families are deliberately distinct, because a supervisor does
 * something different with each: `supported: false` means this delegation can
 * never be steered, so cancel and re-delegate; `accepted: false` means not
 * right now, so wait and try once more; `accepted: true` means the running
 * turn was stopped and re-prompted on the same session.
 *
 * Exit 3 is NOT retried here, unlike every other consult call. A steer already
 * in flight will not clear by immediately trying again, and a duplicate steer —
 * two interruptions of the same turn — is worse than a missed one.
 * @param run - the completed invocation.
 * @param id - the delegation the steer was aimed at.
 * @returns the steer outcome, or an Error to throw for an invocation this plugin got wrong.
 */
export function mapSteerExit(run: ConsultRun, id: DelegationJobId): SteerOutcome | Error {
  const detail = firstLines(run.stderr.trim().length > 0 ? run.stderr : run.stdout, 10, 1000)
  switch (run.exitCode) {
    case CONSULT_EXIT.ok:
      return { supported: true, accepted: true, ...detail.length > 0 ? { detail } : {} }
    case CONSULT_EXIT.internal:
      // consult's own refusal family: an inline or isolated job with no socket
      // to reach, a profile that cannot be steered, or an unreachable broker.
      return { supported: false, reason: detail.length > 0 ? detail : `consult steer ${id} refused the guidance` }
    case CONSULT_EXIT.contention:
      return {
        supported: true,
        accepted: false,
        detail: detail.length > 0 ? detail : 'a steer is already being delivered, or the consult broker is busy',
      }
    case CONSULT_EXIT.notFinal:
      return {
        supported: true,
        accepted: false,
        detail: detail.length > 0 ? detail : `delegation ${id} is not running: it is still queued, or already finished`,
      }
    default:
      return mapExit(run, { command: 'steer', jobId: id }) ?? new Error(`consult steer ${id} failed with exit ${String(run.exitCode)}`)
  }
}

/** Result of bounding one text field. */
export interface BoundedText {
  text: string
  truncated: boolean
}

/**
 * Truncate text to a UTF-8 byte budget without splitting a code point,
 * appending a marker when bytes were dropped.
 * @param text - the untrusted input.
 * @param maxBytes - byte budget for the retained text.
 * @param keep - retain the `head` (answers read forwards) or the `tail` (logs read backwards).
 * @returns the bounded text and whether anything was dropped.
 */
export function boundText(text: string, maxBytes: number, keep: 'head' | 'tail'): BoundedText {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return { text, truncated: false }
  const dropped = buffer.byteLength - maxBytes
  if (keep === 'head') {
    const kept = new TextDecoder('utf8', { fatal: false }).decode(buffer.subarray(0, maxBytes)).replace(/�+$/, '')
    return { text: `${kept}\n[truncated: ${dropped} more bytes not shown]`, truncated: true }
  }
  const kept = new TextDecoder('utf8', { fatal: false }).decode(buffer.subarray(buffer.byteLength - maxBytes)).replace(/^�+/, '')
  return { text: `[truncated: ${dropped} earlier bytes not shown]\n${kept}`, truncated: true }
}

/**
 * Keep the last `maxLines` lines of text within a byte budget.
 * @param text - the untrusted input.
 * @param maxLines - line budget.
 * @param maxBytes - byte budget applied after the line budget.
 * @returns the bounded tail.
 */
export function boundLines(text: string, maxLines: number, maxBytes: number): BoundedText {
  // A rendered transcript ends with a newline; that trailing empty element is a
  // line terminator, not a line, and must not consume the budget.
  const lines = text.replace(/\n$/, '').split('\n')
  const droppedLines = Math.max(0, lines.length - maxLines)
  const kept = droppedLines === 0 ? text : lines.slice(droppedLines).join('\n')
  const bounded = boundText(kept, maxBytes, 'tail')
  return { text: bounded.text, truncated: bounded.truncated || droppedLines > 0 }
}

/** Take the first `maxLines` lines of text, capped at `maxBytes`, without surrounding whitespace. */
function firstLines(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.trim().split('\n').slice(0, maxLines).join('\n')
  return boundText(lines, maxBytes, 'head').text
}

/** consult's record statuses projected onto the seam's vocabulary. */
function projectStatus(raw: string | undefined): DelegationStatus {
  switch (raw) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'cancelled':
    case 'failed':
    case 'skipped':
      return raw
    default:
      return 'unknown'
  }
}

/** Read the authority mode from the envelope's authority block, falling back to the legacy `mode` field. */
function projectMode(job: Record<string, unknown>): DelegationMode {
  const authority = isRecord(job.authority) ? job.authority : undefined
  const mode = stringOf(authority?.mode) ?? stringOf(job.mode)
  return mode === 'write' ? 'write' : 'read-only'
}

function projectArtifacts(artifacts: Record<string, unknown>): DelegationArtifacts | undefined {
  const patchPath = stringOf(artifacts.patchPath)
  const logPath = stringOf(artifacts.logPath)
  const touchedFiles = Array.isArray(artifacts.touchedFiles)
    ? artifacts.touchedFiles.filter((entry): entry is string => typeof entry === 'string')
    : undefined
  const projected: DelegationArtifacts = {
    ...patchPath !== undefined ? { patchPath } : {},
    ...logPath !== undefined ? { logPath } : {},
    ...touchedFiles !== undefined && touchedFiles.length > 0 ? { touchedFiles } : {},
  }
  return Object.keys(projected).length === 0 ? undefined : projected
}

function projectLineage(lineage: Record<string, unknown>): DelegationLineage | undefined {
  const chainId = stringOf(lineage.chainId)
  const parentJobId = stringOf(lineage.parentJobId)
  const childJobIds = Array.isArray(lineage.childJobIds)
    ? lineage.childJobIds.filter((entry): entry is string => typeof entry === 'string')
    : undefined
  const delegationDepth = typeof lineage.delegationDepth === 'number' ? lineage.delegationDepth : undefined
  const projected: DelegationLineage = {
    ...chainId !== undefined ? { chainId } : {},
    ...parentJobId !== undefined ? { parentJobId } : {},
    ...childJobIds !== undefined && childJobIds.length > 0 ? { childJobIds } : {},
    ...delegationDepth !== undefined ? { delegationDepth } : {},
  }
  return Object.keys(projected).length === 0 ? undefined : projected
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) throw internalError('consult produced no JSON output')
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    throw internalError(`consult --json output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function requireEnvelope(parsed: unknown): JobEnvelope {
  if (!isRecord(parsed)) throw internalError('consult --json output was not a JSON object')
  if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw internalError(`unsupported consult JSON schemaVersion ${JSON.stringify(parsed.schemaVersion)}; this plugin reads version ${SUPPORTED_SCHEMA_VERSION}`)
  }
  return sections(parsed)
}

function sections(entry: Record<string, unknown>): JobEnvelope {
  return {
    job: isRecord(entry.job) ? entry.job : {},
    outcome: isRecord(entry.outcome) ? entry.outcome : {},
    artifacts: isRecord(entry.artifacts) ? entry.artifacts : {},
    lineage: isRecord(entry.lineage) ? entry.lineage : {},
  }
}

function internalError(message: string): DelegationError {
  return new DelegationError('internal', message)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
