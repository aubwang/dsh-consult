/**
 * A second, deliberately trivial provider for the delegation seam — dsh-native,
 * with no consult anywhere in it.
 *
 * It exists to keep the seam honest. `ctx.delegation` was designed alongside
 * exactly one implementation, which is the classic way an interface quietly
 * becomes a description of its only provider. Standing up a second one that
 * shares none of consult's machinery is the cheapest test of whether the
 * vocabulary is really provider-neutral, and the friction it surfaces is
 * recorded in the package README rather than smoothed over here.
 *
 * A delegation is one short-lived subprocess spawned through `ctx.subprocess`,
 * so completion is genuinely asynchronous and cancellation genuinely kills
 * something. Everything else is an in-memory record that dies with the process.
 * This is a test double with a real service shell, not a product: it has no
 * durability, no isolation, no authority enforcement, and no second turn.
 *
 * It lives beside `provider.ts` rather than under a `providers/` directory
 * because every other module in this package is a flat leaf, and one provider
 * is already published at the `./provider` subpath.
 * @module @aubwang/dsh-consult/toy-provider
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { boundLines, boundText } from './bounds.ts'
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
  type DelegationResult,
  type DelegationStatus,
  type ReviewSpec,
  type SteerOutcome,
} from './seam.ts'

export const name = 'toy-delegation'

/** The one delegate identity this provider has; the seam requires a name for it. */
const TOY_PROFILE = 'toy'

/**
 * The whole delegate: sleep, then answer. The sleep is what makes completion
 * asynchronous and cancellation observable — a delegate that answered
 * instantly would let a broken cancel path pass every test.
 */
const TOY_SCRIPT = 'const prompt = process.env.TOY_PROMPT ?? ""\n'
  + 'setTimeout(() => process.stdout.write(`toy delegate answered: ${prompt}\\n`), Number(process.env.TOY_DELAY_MS ?? "50"))\n'

/** Configuration for the toy provider. */
export interface Config {
  /** Working directory for each delegation. Defaults to the harness process cwd. */
  cwd?: string
  /** How long a delegation "thinks" before answering. */
  delayMs?: number
  /** Byte cap for model-facing answer and transcript text. */
  maxTextBytes?: number
  /** Rendered transcript lines returned when a caller does not ask for a tail. */
  logTailLines?: number
  /** SIGTERM→SIGKILL grace for a cancelled delegation. */
  graceMs?: number
}

type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

/** One in-memory delegation record. */
interface ToyRecord {
  id: DelegationJobId
  status: DelegationStatus
  label?: string
  mode: DelegationJob['mode']
  submittedAt: string
  finishedAt?: string
  finalText?: string
  /** True when ANY layer dropped bytes: the stdout collector, or the model-facing bound. */
  finalTextTruncated: boolean
  errorMessage?: string
  transcript: string[]
  handle: SubprocessHandle | undefined
  /** Settles when the record reaches a terminal status. Never rejects. */
  settled: Promise<void>
}

/**
 * An in-memory delegation provider over one subprocess per job.
 *
 * Mounting this and the consult provider in the same context is a conflict by
 * design: cordis allows one implementation per service name, so a composition
 * chooses exactly one `ctx.delegation`.
 */
export class ToyDelegation extends DelegationService {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    cwd: z.string(),
    delayMs: z.number().min(0).default(50),
    maxTextBytes: z.number().min(256).default(16_000),
    logTailLines: z.number().min(1).default(40),
    graceMs: z.number().min(1).default(1_000),
  })

  readonly config: ResolvedConfig

  private readonly records = new Map<DelegationJobId, ToyRecord>()
  private sequence = 0

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    // Disposal cancels whatever is still running, so a reloaded plugin leaves
    // no orphaned subprocess behind.
    ctx.effect(() => () => {
      for (const record of this.records.values()) this.finish(record, 'cancelled')
    })
  }

  override capabilities(_options?: DelegationCallOptions): Promise<DelegationCapabilities> {
    return Promise.resolve({
      ready: true,
      version: '0.0.0-toy',
      profiles: [TOY_PROFILE],
      defaultProfile: TOY_PROFILE,
      canSteer: false,
      canReport: false,
    })
  }

  override delegate(spec: DelegateSpec, options?: DelegationCallOptions): Promise<DelegationJob> {
    if (spec.prompt.trim().length === 0) {
      throw new DelegationError('unsupported', 'a delegation prompt must be non-empty')
    }
    if (spec.isolated === true) {
      // The seam models isolation as a detached worktree. This provider has no
      // checkout to detach, so the honest answer is that it cannot serve the
      // request rather than pretending the flag was applied.
      throw new DelegationError('unsupported', 'the toy provider cannot isolate a delegation: it has no workspace to detach')
    }
    if (spec.after !== undefined && spec.after.length > 0) {
      throw new DelegationError('unsupported', 'the toy provider does not chain delegations')
    }
    this.sequence += 1
    const id = `toy-${this.sequence}` as DelegationJobId
    const record: ToyRecord = {
      id,
      status: 'queued',
      ...spec.label !== undefined ? { label: spec.label } : {},
      mode: spec.mode ?? 'read-only',
      submittedAt: new Date().toISOString(),
      finalTextTruncated: false,
      transcript: [`[${new Date().toISOString()}] queued`],
      handle: undefined,
      settled: Promise.resolve(),
    }
    let release = (): void => {}
    record.settled = new Promise<void>((resolve) => { release = resolve })
    this.records.set(id, record)
    this.start(record, spec.prompt, options, release)
    return Promise.resolve(this.project(record))
  }

  /** Spawn the one subprocess that stands in for a delegate's turn. */
  private start(record: ToyRecord, prompt: string, options: DelegationCallOptions | undefined, release: () => void): void {
    const handle = this.ctx.subprocess.spawn({
      argv: [process.execPath, '-e', TOY_SCRIPT],
      cwd: this.config.cwd ?? options?.cwd ?? process.cwd(),
      // The collector gets headroom over the model-facing budget on purpose, so
      // that in the ordinary case `boundText` is the layer that truncates — it
      // keeps the HEAD and states what it dropped, whereas the collector keeps
      // the tail silently. A delegate that overruns even this still loses bytes
      // in the collector, which is why the read's `lossy` flag is consulted too.
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.collectBytes() }, stderr: { maxBytes: 4_096 } },
      graceMs: this.config.graceMs,
      env: { TOY_PROMPT: prompt, TOY_DELAY_MS: String(this.config.delayMs) },
    })
    record.handle = handle
    record.status = 'running'
    record.transcript.push(`[${new Date().toISOString()}] running`)
    void handle.done.then(
      (outcome) => {
        const read = handle.collected.stdout?.readFrom(0)
        if (record.status === 'cancelled') return
        if (outcome.exitCode === 0) {
          const bounded = boundText(read?.text.trim() ?? '', this.config.maxTextBytes, 'head')
          record.finalText = bounded.text
          // Two layers can shorten an answer, and the caller must never be
          // handed a short one that claims to be complete. `lossy` means the
          // collector's window slid — which, because the collector is sized
          // above the model-facing budget, also guarantees the retained tail
          // still overruns that budget, so `boundText` has already written the
          // marker. The flag is the OR because the FACT of truncation belongs
          // to the record, not to whichever layer happened to notice it.
          record.finalTextTruncated = bounded.truncated || (read?.lossy ?? false)
          this.finish(record, 'completed')
          return
        }
        record.errorMessage = `the toy delegate exited ${outcome.exitCode ?? `by signal ${outcome.signal ?? 'unknown'}`}`
        this.finish(record, 'failed')
      },
      (error: unknown) => {
        record.errorMessage = `the toy delegate could not start: ${error instanceof Error ? error.message : String(error)}`
        this.finish(record, 'failed')
      },
    ).finally(release)
  }

  /** Move a record to a terminal status exactly once. */
  private finish(record: ToyRecord, status: DelegationStatus): void {
    if (record.finishedAt !== undefined) return
    record.status = status
    record.finishedAt = new Date().toISOString()
    record.transcript.push(`[${record.finishedAt}] ${status}`)
    if (record.finalText !== undefined) record.transcript.push(record.finalText)
    record.handle?.terminate()
  }

  /**
   * In-memory cap for a delegation's stdout. Double the model-facing budget, so
   * an answer that overruns the budget is trimmed by the layer that marks the
   * trim rather than by the one that drops bytes silently.
   */
  private collectBytes(): number {
    return this.config.maxTextBytes * 2
  }

  private require(id: DelegationJobId): ToyRecord {
    const record = this.records.get(id)
    // The seam has no domain code for "no such delegation", so this follows the
    // same convention as the consult provider: an id the provider never issued
    // is a caller bug, not an outcome to reason about.
    if (record === undefined) throw new Error(`unknown delegation ${id}`)
    return record
  }

  private project(record: ToyRecord): DelegationJob {
    return {
      id: record.id,
      status: record.status,
      ...record.label !== undefined ? { label: record.label } : {},
      profile: TOY_PROFILE,
      mode: record.mode,
      kind: 'delegate',
      submittedAt: record.submittedAt,
      ...record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {},
    }
  }

  private projectResult(record: ToyRecord): DelegationResult {
    return {
      ...this.project(record),
      ...record.finalText !== undefined
        ? { finalText: record.finalText, finalTextTruncated: record.finalTextTruncated }
        : {},
      ...record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {},
    }
  }

  override review(_spec: ReviewSpec, _options?: DelegationCallOptions): Promise<DelegationJob> {
    // ReviewSpec pins its input as a git base ref or a prior job's patch, and
    // this provider has neither. Refusing is more honest than delegating a
    // prompt that says "review" and calling the result a review.
    return Promise.reject(new DelegationError(
      'review-unsupported',
      'the toy provider serves no reviews: it has no git workspace to pin a change against',
    ))
  }

  override status(id?: DelegationJobId, _options?: DelegationCallOptions): Promise<DelegationJob[]> {
    if (id === undefined) return Promise.resolve([...this.records.values()].map((record) => this.project(record)))
    return Promise.resolve([this.project(this.require(id))])
  }

  override async wait(
    ids: readonly DelegationJobId[],
    timeoutMs: number,
    _options?: DelegationCallOptions,
  ): Promise<DelegationResult[]> {
    if (ids.length === 0) return []
    const records = ids.map((id) => this.require(id))
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
      timer.unref?.()
    })
    try {
      const outcome = await Promise.race([
        Promise.all(records.map((record) => record.settled)).then(() => 'settled' as const),
        expired,
      ])
      if (outcome === 'timeout') {
        throw new DelegationError('timeout', `waiting for ${ids.join(', ')} exceeded ${timeoutMs}ms`, { jobId: ids[0] as DelegationJobId })
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    return records.map((record) => this.projectResult(record))
  }

  override result(id: DelegationJobId, _options?: DelegationCallOptions): Promise<DelegationResult> {
    const record = this.require(id)
    if (record.finishedAt === undefined) {
      throw new DelegationError('not-final', `delegation ${id} has not finished`, { jobId: id, status: record.status })
    }
    return Promise.resolve(this.projectResult(record))
  }

  override logs(id: DelegationJobId, tail?: number, _options?: DelegationCallOptions): Promise<string> {
    const record = this.require(id)
    const lines = tail ?? this.config.logTailLines
    return Promise.resolve(boundLines(record.transcript.join('\n'), lines, this.config.maxTextBytes).text)
  }

  override cancel(id: DelegationJobId, _options?: DelegationCallOptions): Promise<void> {
    const record = this.require(id)
    if (record.finishedAt === undefined) this.finish(record, 'cancelled')
    return Promise.resolve()
  }

  override steer(_id: DelegationJobId, _guidance: string, _options?: DelegationCallOptions): Promise<SteerOutcome> {
    return Promise.resolve({
      supported: false,
      reason: 'the toy provider runs one turn per delegation and cannot redirect it; cancel and delegate again',
    })
  }

  override events(_id: DelegationJobId, _fromSeq?: number, _options?: DelegationCallOptions): Promise<DelegationEventPage> {
    return Promise.resolve({
      supported: false,
      events: [],
      reason: 'the toy provider has no upward event channel',
    })
  }

  override watch(_id: DelegationJobId, _listener: (event: DelegationEvent) => void, _options?: DelegationCallOptions): () => void {
    return () => {}
  }

  override onEvent(_listener: (event: DelegationEvent) => void): () => void {
    return () => {}
  }
}

export default ToyDelegation
