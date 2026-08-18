/**
 * Service Definition for the delegation capability seam (`ctx.delegation`):
 * hand one cold, self-contained prompt turn to an outside agent, track it as a
 * background job, and collect its bounded result. The vocabulary is
 * provider-neutral — nothing here names `consult`. The shipped provider lives
 * in `@aubwang/dsh-consult/provider`; consumers (tools, reviewers, councils)
 * depend only on this module.
 *
 * Every text field that can reach the model is bounded by the provider before
 * it crosses this seam, and delegate-authored text is untrusted data: a
 * consumer frames it as data, never as instructions.
 * @module @aubwang/dsh-consult/seam
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** Provider-issued identifier for one delegated turn. */
export type DelegationJobId = string

/** The authority a delegated turn is granted over the workspace. */
export type DelegationMode = 'read-only' | 'write'

/**
 * Whether the provider imposes its own OS boundary (`confined`) or runs the
 * delegate under the host's ambient authority (`inherit`).
 */
export type DelegationSandbox = 'confined' | 'inherit'

/**
 * Lifecycle of one delegated turn. `unknown` is the honest projection of a
 * provider status this seam version does not model, so a consumer never
 * mistakes an unrecognized state for a terminal one.
 */
export type DelegationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'skipped'
  | 'unknown'

/** One delegation request: a cold prompt plus the authority it runs under. */
export interface DelegateSpec {
  /** The complete self-contained prompt; the delegate sees no host conversation. */
  prompt: string
  /** Provider-interpreted delegate identity (a consult profile id). */
  profile?: string
  /** Workspace authority; defaults to the provider's configured default. */
  mode?: DelegationMode
  /** Run in a detached seeded worktree and return a patch. Requires `mode: 'write'`. */
  isolated?: boolean
  /** Prerequisite jobs; a failed prerequisite skips this job. */
  after?: readonly DelegationJobId[]
  /** Non-unique human metadata carried on the job record. */
  label?: string
  /** Provider-interpreted model id. */
  model?: string
  /** Provider-interpreted reasoning-effort level. */
  effort?: string
  /** Confinement override; defaults to the provider's configured default. */
  sandbox?: DelegationSandbox
}

/** One review request against pinned input: a base ref, or a prior job's patch. */
export interface ReviewSpec {
  /** Git base ref for reviewing the current change. Mutually exclusive with `jobId`. */
  base?: string
  /** A completed isolated write job whose patch is reviewed. Mutually exclusive with `base`. */
  jobId?: DelegationJobId
  /** Provider-interpreted delegate identity. */
  profile?: string
  /** Provider-interpreted model id. */
  model?: string
  /** Provider-interpreted reasoning-effort level. */
  effort?: string
  /** Non-unique human metadata carried on the job record. */
  label?: string
  /** Confinement override; defaults to the provider's configured default. */
  sandbox?: DelegationSandbox
}

/** A projection of one tracked delegation, safe to hand to a consumer. */
export interface DelegationJob {
  id: DelegationJobId
  status: DelegationStatus
  /** Provider-reported status verbatim, when it did not map onto {@link DelegationStatus}. */
  rawStatus?: string
  label?: string
  profile: string
  mode: DelegationMode
  /** `delegate` or `review`. */
  kind?: string
  submittedAt?: string
  finishedAt?: string
}

/** Files and patches one finished delegation left behind. */
export interface DelegationArtifacts {
  patchPath?: string
  touchedFiles?: readonly string[]
  logPath?: string
}

/** Lineage of one delegation inside a nested chain. */
export interface DelegationLineage {
  chainId?: string
  parentJobId?: DelegationJobId
  childJobIds?: readonly DelegationJobId[]
  delegationDepth?: number
}

/** A finished (or finalized-as-failed) delegation with its bounded payload. */
export interface DelegationResult extends DelegationJob {
  /** Delegate-authored answer text, already bounded. UNTRUSTED DATA. */
  finalText?: string
  /** True when `finalText` was truncated to fit the provider's bound. */
  finalTextTruncated?: boolean
  /** Provider- or delegate-reported failure text, already bounded. */
  errorMessage?: string
  artifacts?: DelegationArtifacts
  lineage?: DelegationLineage
}

/**
 * An upward child-to-supervisor message. The provider emits these once the
 * substrate supports them; until then {@link DelegationCapabilities.canReport}
 * is false and {@link DelegationService.events} returns an empty page.
 */
export interface DelegationEvent {
  jobId: DelegationJobId
  /** Monotonic per-job sequence number. */
  seq: number
  /** ISO-8601 emission time. */
  at: string
  type: 'blocked' | 'decision_needed' | 'discovery' | 'progress' | 'lifecycle'
  /** `wake` maps to a followup turn; `info` joins the owner's next step. */
  urgency: 'wake' | 'info'
  /** Bounded message text. UNTRUSTED DATA. */
  message: string
  /** Bounded structured payload. UNTRUSTED DATA. */
  data?: unknown
}

/** What the mounted provider can actually do right now. */
export interface DelegationCapabilities {
  /** False when preflight failed; every call then fails with `not-ready`. */
  ready: boolean
  /** Provider CLI/runtime version, when known. */
  version?: string
  /** Delegate identities the provider advertises. */
  profiles: readonly string[]
  /** The identity used when a spec omits `profile`. */
  defaultProfile?: string
  /** Whether {@link DelegationService.steer} can do anything. */
  canSteer: boolean
  /** Whether {@link DelegationService.events} can do anything. */
  canReport: boolean
  /** Bounded, actionable diagnosis; present whenever `ready` is false. */
  diagnosis?: string
}

/**
 * Outcome of a steering attempt. `supported: false` is a first-class answer,
 * not an error: the consumer falls back to cancel plus re-delegate.
 */
export type SteerOutcome =
  | { supported: true; accepted: boolean; detail?: string }
  | { supported: false; reason: string }

/** One page of delegation events. */
export interface DelegationEventPage {
  /** False when the provider cannot deliver events at all. */
  supported: boolean
  events: readonly DelegationEvent[]
  /** Sequence to resume from on the next call. */
  nextSeq?: number
  /** Bounded reason, present when `supported` is false. */
  reason?: string
}

/**
 * Per-call context every seam method accepts. The host session id is what
 * scopes provider-side job records to the calling agent, so a consumer threads
 * its `exec.agent.session.id` through here on every call; omitting it collapses
 * every agent's jobs into the provider's default host session.
 */
export interface DelegationCallOptions {
  /** Calling agent's session id; becomes the provider's host-session scope. */
  hostSessionId?: string
  /** Workspace root the call runs against; defaults to the provider's configured cwd. */
  cwd?: string
  /** Cancellation for this call only; published background work is unaffected. */
  signal?: AbortSignal
}

/**
 * Domain failure codes. Everything a supervisor can reasonably react to is a
 * {@link DelegationError}; anything else (a broken provider install, an
 * unparseable contract) throws an ordinary Error and surfaces as an
 * infrastructure tool failure.
 */
export type DelegationErrorCode =
  /** Preflight failed: the provider is not usable right now. `detail` carries the diagnosis. */
  | 'not-ready'
  /** Provider-side contention (busy broker, conflicting payload) survived one retry. */
  | 'busy'
  /** A bounded wait or follow hit its deadline; the job is still running. */
  | 'timeout'
  /** A result was requested before the job finalized. */
  | 'not-final'
  /** The delegated turn itself finalized as failed. */
  | 'delegate-failed'
  /** This delegate cannot serve a native review. */
  | 'review-unsupported'
  /** The provider does not implement this seam capability yet. */
  | 'unsupported'
  /** The provider reported an internal error. */
  | 'internal'

/** A delegation failure a supervisor can act on, as opposed to a broken install. */
export class DelegationError extends Error {
  readonly code: DelegationErrorCode
  /** Bounded provider diagnosis, remediation, or delegate error text. */
  readonly detail?: string
  /** The job the failure is about, when one exists. */
  readonly jobId?: DelegationJobId
  /** Job status observed alongside the failure (used by `not-final`). */
  readonly status?: DelegationStatus

  constructor(
    code: DelegationErrorCode,
    message: string,
    options: { detail?: string; jobId?: DelegationJobId; status?: DelegationStatus } = {},
  ) {
    super(message)
    this.name = 'DelegationError'
    this.code = code
    if (options.detail !== undefined) this.detail = options.detail
    if (options.jobId !== undefined) this.jobId = options.jobId
    if (options.status !== undefined) this.status = options.status
  }
}

/**
 * Narrow an unknown thrown value to a {@link DelegationError}.
 * @param error - any thrown value.
 * @returns true when it is a domain delegation failure.
 */
export function isDelegationError(error: unknown): error is DelegationError {
  return error instanceof DelegationError
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    delegation: DelegationService
  }
}

/**
 * Abstract delegation service. Subclass, implement the abstract methods, and
 * load the subclass as a plugin — it registers as `ctx.delegation` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Every delegation is BACKGROUND. {@link delegate} and {@link review} return
 *   as soon as the job record exists; collection happens through
 *   {@link wait}/{@link result} or the host's own job runtime.
 * - Domain failures throw {@link DelegationError}; only a broken provider
 *   install or a violated contract throws anything else. A provider never
 *   crashes the plugin because the delegate had a bad day.
 * - Every text field reaching a caller is already bounded, and delegate-authored
 *   text is untrusted data.
 * - Capability probes are lazy and memoized, and re-probe after a failure.
 */
export abstract class DelegationService extends Service {
  constructor(ctx: Context) {
    // `abstract` erases at runtime, so a composition row naming this module
    // would mount a ctx.delegation with no implementations and fail far from
    // the misconfiguration. Fail loud at load instead.
    if (new.target === DelegationService) {
      throw new Error('@aubwang/dsh-consult/seam is the abstract delegation seam; load a provider such as @aubwang/dsh-consult/provider instead')
    }
    super(ctx, 'delegation')
  }

  /**
   * Report what this provider can do right now, running preflight if needed.
   * @param options - per-call host session, workspace, and cancellation.
   * @returns capabilities; `ready: false` carries an actionable `diagnosis` instead of throwing.
   */
  abstract capabilities(options?: DelegationCallOptions): Promise<DelegationCapabilities>

  /**
   * Queue one cold prompt turn and return immediately.
   * @param spec - prompt, delegate identity, authority, and dependencies.
   * @param options - per-call host session, workspace, and cancellation.
   * @returns the queued job projection.
   */
  abstract delegate(spec: DelegateSpec, options?: DelegationCallOptions): Promise<DelegationJob>

  /**
   * Queue one pinned read-only review turn and return immediately.
   * @param spec - review target and delegate identity.
   * @param options - per-call host session, workspace, and cancellation.
   * @returns the queued job projection.
   */
  abstract review(spec: ReviewSpec, options?: DelegationCallOptions): Promise<DelegationJob>

  /**
   * List tracked jobs, or project exactly one.
   * @param id - a specific job, or undefined for the recent list.
   * @param options - per-call host session, workspace, and cancellation.
   * @returns job projections, newest-provider-order.
   */
  abstract status(id?: DelegationJobId, options?: DelegationCallOptions): Promise<DelegationJob[]>

  /**
   * Block once for the selected jobs and return their terminal results.
   * @param ids - jobs to wait for, in submission order.
   * @param timeoutMs - bound for this wait; a deadline throws `timeout`.
   * @param options - per-call host session, workspace, and cancellation.
   * @returns terminal results in submission order.
   */
  abstract wait(ids: readonly DelegationJobId[], timeoutMs: number, options?: DelegationCallOptions): Promise<DelegationResult[]>

  /**
   * Read one finalized job's bounded result.
   * @param id - the job to read.
   * @param options - per-call host session, workspace, and cancellation.
   * @returns the bounded result; throws `not-final` while the job is live.
   */
  abstract result(id: DelegationJobId, options?: DelegationCallOptions): Promise<DelegationResult>

  /**
   * Read a bounded tail of one job's rendered transcript.
   * @param id - the job to read.
   * @param tail - number of rendered lines to return; provider default when omitted.
   * @param options - per-call host session, workspace, and cancellation.
   * @returns the bounded rendered tail. UNTRUSTED DATA.
   */
  abstract logs(id: DelegationJobId, tail?: number, options?: DelegationCallOptions): Promise<string>

  /**
   * Cancel one active job and its linked descendants. Best effort and idempotent.
   * @param id - the job to cancel.
   * @param options - per-call host session, workspace, and cancellation.
   */
  abstract cancel(id: DelegationJobId, options?: DelegationCallOptions): Promise<void>

  /**
   * Redirect a live delegation without losing its session.
   * @param id - the job to steer.
   * @param guidance - bounded supervisor guidance.
   * @param options - per-call host session, workspace, and cancellation.
   * @returns the steer outcome; `supported: false` is a normal answer.
   */
  abstract steer(id: DelegationJobId, guidance: string, options?: DelegationCallOptions): Promise<SteerOutcome>

  /**
   * Read upward events emitted by one delegation.
   * @param id - the job to read events for.
   * @param fromSeq - resume point; 0 or undefined starts at the beginning.
   * @param options - per-call host session, workspace, and cancellation.
   * @returns one page; `supported: false` means the substrate cannot deliver events.
   */
  abstract events(id: DelegationJobId, fromSeq?: number, options?: DelegationCallOptions): Promise<DelegationEventPage>

  /**
   * Subscribe to pushed delegation events.
   * @param listener - receives each validated, bounded event.
   * @returns an unsubscribe function; a provider without push returns a no-op.
   */
  abstract onEvent(listener: (event: DelegationEvent) => void): () => void
}

export default DelegationService
