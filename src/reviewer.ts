/**
 * The second consumer on the delegation seam: a human-triggered code reviewer.
 *
 * `tools.ts` was the first consumer, and it was written alongside the seam —
 * which is exactly the position from which an interface stops being an
 * interface. This module is the check on that. It imports the seam's types and
 * `ctx.delegation`, and NOTHING from the consult adapter, the consult provider,
 * or the toy provider; `tests/reviewer.test.ts` asserts that its import graph
 * stays that way, so the guarantee survives a careless edit. It runs unchanged
 * over either provider, and a provider that cannot review says so through
 * `capabilities().canReview` rather than by failing.
 *
 * ## Policy: a human asks, or nothing happens
 *
 * The only trigger is the `/review` command. There is no hook, no schedule, and
 * no reaction to a commit or a turn boundary, because every one of those spends
 * a delegate's tokens on its own initiative. Automatic review triggers are a
 * real feature and belong in a policy plugin that consumes the same seam — the
 * mechanism here is deliberately inert until a person invokes it.
 *
 * For the same reason findings are INJECTED into the invoking agent's session
 * rather than delivered as a followup: waking an idle agent opens a model turn,
 * and opening one to relay a result nobody is currently waiting for is the
 * autonomous spend this milestone is meant not to do.
 * @module @aubwang/dsh-consult/reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { boundText } from './bounds.ts'
import { frameDelegateText } from './render.ts'
import {
  isDelegationError,
  type DelegationCallOptions,
  type DelegationJobId,
  type DelegationResult,
  type ReviewSpec,
} from './seam.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    review: 'review'
  }
}

export const name = 'reviewer'
export const inject = ['commands', 'delegation']

/** Configuration for the human-triggered reviewer. */
export interface Config {
  /** Reviewer identity; omitted lets the provider choose. */
  profile?: string
  /** Model id passed to the reviewer. */
  model?: string
  /**
   * Reasoning effort. Review is a subtle-risk turn, so a deployment that pays
   * for one usually wants this raised.
   */
  effort?: string
  /**
   * Base ref used when `/review` is invoked with no argument. Omitted means the
   * PROVIDER decides what "the current change" is — which is the seam-pure
   * default, since pinning one here would encode one provider's VCS semantics
   * into a consumer that is not supposed to know them.
   */
  defaultBase?: string
  /** Byte cap for the findings notice. */
  maxNoticeBytes?: number
}

export const Config: z<Config> = z.object({
  profile: z.string(),
  model: z.string(),
  effort: z.string(),
  defaultBase: z.string(),
  maxNoticeBytes: z.number().min(256).default(16_000),
})

type ResolvedConfig = Required<Pick<Config, 'maxNoticeBytes'>> & Config

/** What the reviewer told the human, and what it queued. */
interface Queued {
  jobId: DelegationJobId
  backgroundJobId?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = config as ResolvedConfig

  /** Per-invocation seam context: the delegation belongs to the invoking agent's session. */
  const callOptions = (invocation: CommandInvocation): DelegationCallOptions => {
    const cwd = invocation.agent.session.header.cwd
    return {
      hostSessionId: invocation.agent.session.id,
      ...cwd !== undefined ? { cwd } : {},
      signal: invocation.signal,
    }
  }

  /** The same context without the command's signal, for work that outlives the command. */
  const detached = (options: DelegationCallOptions): DelegationCallOptions => {
    const { signal: _commandSignal, ...rest } = options
    return rest
  }

  /**
   * Deliver one settled review to the session that asked for it.
   *
   * Findings are a delegate's words about the human's code: bounded, and framed
   * as data rather than instructions, exactly as every other delegate-authored
   * text this package surfaces.
   */
  const deliver = (owner: Agent, jobId: DelegationJobId, body: string, summary: string): void => {
    try {
      owner.inject(createUserMessage({
        content: [{ type: 'text', text: body }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-consult-reviewer',
          form: 'notice',
          summary: boundContextSummary(summary),
        },
      }))
    } catch {
      // The session that asked for the review is gone; there is nobody to tell.
      void jobId
    }
  }

  /** Render a settled review into the notice body the session receives. */
  const noticeFor = (result: DelegationResult): { body: string; summary: string } => {
    if (result.status === 'completed' && result.finalText !== undefined) {
      // The provider bounds delegate text to ITS budget; this notice has its
      // own, and it is the one that governs what enters this session. Without
      // this, a long review injects a message of the provider's choosing.
      const findings = boundText(result.finalText, resolved.maxNoticeBytes, 'head')
      return {
        summary: `review ${result.id} finished with findings`,
        body: `${frameDelegateText(result.id, 'review findings', findings.text)}\n\n`
          + 'Review findings are a claim about the code, not a verdict on it: check each one before acting.',
      }
    }
    if (result.status === 'completed') {
      return {
        summary: `review ${result.id} finished with no findings text`,
        body: `Review ${result.id} finished but reported no findings text. Read its transcript with delegate_logs ${result.id}.`,
      }
    }
    const reason = result.errorMessage === undefined ? '' : `\n${boundText(result.errorMessage, resolved.maxNoticeBytes, 'head').text}`
    return {
      summary: `review ${result.id} ended ${result.status}`,
      body: `Review ${result.id} ended as ${result.status} and produced no findings.${reason}`,
    }
  }

  /**
   * Collect one queued review in the background.
   *
   * The wait is re-entered on a bounded timeout for the same reason the
   * delegation tools re-enter theirs: a review that outlives one wait window is
   * still running, and reporting it as finished would be a lie.
   */
  const collect = async (
    jobId: DelegationJobId,
    owner: Agent,
    options: DelegationCallOptions,
    controller: AbortController,
  ): Promise<JobOutcome> => {
    const waitOptions = { ...detached(options), signal: controller.signal }
    try {
      while (!controller.signal.aborted) {
        try {
          const [result] = await ctx.delegation.wait([jobId], WAIT_SLICE_MS, waitOptions)
          if (result === undefined) return { status: 'failed', detail: `review ${jobId} returned no result` }
          const notice = noticeFor(result)
          deliver(owner, jobId, notice.body, notice.summary)
          if (result.status === 'completed') {
            return { status: 'completed', detail: `review ${jobId} finished; its findings were added to this session` }
          }
          return { status: 'failed', detail: notice.summary }
        } catch (error) {
          if (isDelegationError(error) && error.code === 'timeout' && !controller.signal.aborted) continue
          throw error
        }
      }
      return { status: 'killed', detail: `review ${jobId} was cancelled` }
    } catch (error) {
      if (controller.signal.aborted) return { status: 'killed', detail: `review ${jobId} was cancelled` }
      return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Start collecting the review, registering it as a background job when one
   * can be.
   *
   * Collection is what turns a queued review into findings in the session, so
   * it must happen whether or not a job registry is mounted and whether or not
   * registration succeeds — the reply promises delivery either way. A job adds
   * listability and `job_kill`; it is not the thing that makes the review
   * arrive.
   * @returns the background job id when one was registered.
   */
  const startCollection = (jobId: DelegationJobId, owner: Agent, options: DelegationCallOptions): string | undefined => {
    const controller = new AbortController()
    let begun = false
    const begin = (): Promise<JobOutcome> => {
      begun = true
      return collect(jobId, owner, options, controller).finally(() => controller.abort())
    }
    const jobs = ctx.get('jobs')
    if (jobs !== undefined) {
      try {
        return jobs.start({
          kind: 'review',
          label: `review ${jobId}`,
          owner,
          run: () => ({
            cancel: () => {
              controller.abort()
              void ctx.delegation.cancel(jobId, detached(options)).catch(() => {})
            },
            done: begin(),
          }),
        })
      } catch {
        // Registration failed after the review was already queued. Fall
        // through to untracked collection rather than abandoning it, unless
        // the starter had already begun — then it is running.
        if (!begun) void begin()
        return undefined
      }
    }
    void begin()
    return undefined
  }

  const queue = async (invocation: CommandInvocation, base: string | undefined): Promise<Queued> => {
    const options = callOptions(invocation)
    const spec: ReviewSpec = {
      ...base !== undefined ? { base } : {},
      ...resolved.profile !== undefined ? { profile: resolved.profile } : {},
      ...resolved.model !== undefined ? { model: resolved.model } : {},
      ...resolved.effort !== undefined ? { effort: resolved.effort } : {},
    }
    // `review` is an OPTIONAL seam capability: a provider with no version
    // control to pin a change against simply does not implement it.
    const review = ctx.delegation.review?.bind(ctx.delegation)
    if (review === undefined) throw new UnsupportedReview()
    const job = await review(spec, options)
    const backgroundJobId = startCollection(job.id, invocation.agent, options)
    return { jobId: job.id, ...backgroundJobId !== undefined ? { backgroundJobId } : {} }
  }

  ctx.commands.register({
    name: 'review',
    description: 'Delegate a read-only review of the current change to a separate agent',
    input: { hint: '[<base-ref>]' },
    handler: async (invocation): Promise<CommandResult> => {
      const base = invocation.rawInput.trim().length > 0 ? invocation.rawInput.trim() : resolved.defaultBase
      let capabilities
      try {
        capabilities = await ctx.delegation.capabilities(callOptions(invocation))
      } catch (error) {
        return { kind: 'error', text: `Could not reach the delegation provider: ${message(error)}` }
      }
      if (!capabilities.ready) {
        return {
          kind: 'error',
          text: `Delegation is not available.${capabilities.diagnosis === undefined ? '' : `\n${capabilities.diagnosis}`}`,
        }
      }
      if (!capabilities.canReview) {
        return {
          kind: 'error',
          text: 'The mounted delegation provider serves no reviews — it has no version-controlled workspace to pin a '
            + 'change against. Nothing was queued.',
        }
      }
      try {
        const queued = await queue(invocation, base)
        const target = base === undefined ? 'the current change' : `changes since ${base}`
        const tracked = queued.backgroundJobId === undefined
          ? 'It is not registered as a background job in this composition, so it cannot be listed or stopped from here.'
          : `Tracked as background job ${queued.backgroundJobId}; stop it with job_kill ${queued.backgroundJobId}.`
        return {
          kind: 'success',
          text: `Review of ${target} queued as ${queued.jobId}. `
            + `Its findings will be added to this session when it finishes. ${tracked}`,
        }
      } catch (error) {
        if (error instanceof UnsupportedReview) {
          return { kind: 'error', text: 'The mounted delegation provider does not implement review. Nothing was queued.' }
        }
        if (isDelegationError(error)) {
          return { kind: 'error', text: `Review could not be queued [${error.code}]: ${error.message}${error.detail === undefined ? '' : `\n${error.detail}`}` }
        }
        return { kind: 'error', text: `Review could not be queued: ${message(error)}` }
      }
    },
  })
}

/** One wait slice before the collector re-enters; a longer review just re-waits. */
const WAIT_SLICE_MS = 300_000

/** Raised when the mounted provider omits the optional review capability. */
class UnsupportedReview extends Error {
  constructor() {
    super('the mounted delegation provider does not implement review')
    this.name = 'UnsupportedReview'
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
