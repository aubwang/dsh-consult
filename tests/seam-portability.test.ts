/**
 * The seam's honesty test: run the SAME model-facing tools against a provider
 * that shares nothing with consult.
 *
 * `tools.ts` was written alongside exactly one provider, so the risk it is
 * really a consult client wearing an interface is not hypothetical. Nothing
 * here mounts `ConsultDelegation`, spawns a consult, or reads a consult
 * envelope; the composition is identical except for the one row that provides
 * `ctx.delegation`. Every assertion that still holds is a claim about the seam
 * rather than about consult.
 *
 * The friction this exercise surfaced is recorded in the package README, not
 * papered over here.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { ToyDelegation, type Config as ToyConfig } from '../src/toy-provider.ts'
import * as DelegateTools from '../src/tools.ts'
import { registerOwner, text, toolCaller, until, value, type FakeOwner, type ToolCaller } from './support.ts'

interface Harness {
  ctx: Context
  call: ToolCaller
  owner(sessionId: string): FakeOwner
}

const teardown: Array<() => Promise<void>> = []

async function setup(toy: ToyConfig = {}): Promise<Harness> {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(LocalSubprocessRuntime),
    await ctx.plugin(AgentRegistry),
    await ctx.plugin(LocalJobRegistry),
  ]
  ctx.jobs.attachController('test')
  // The one row that differs from tools.test.ts.
  fibers.push(await ctx.plugin(ToyDelegation, toy))
  fibers.push(await ctx.plugin(DelegateTools, {}))
  teardown.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  return {
    ctx,
    call: toolCaller(ctx),
    owner: (sessionId) => {
      const registered = registerOwner(ctx, sessionId, { status: 'idle' })
      teardown.push(registered.dispose)
      return registered.owner
    },
  }
}

after(async () => {
  for (const dispose of teardown) await dispose()
})

/** The delegation the tools reported starting. */
const startedJobId = (result: ToolExecutionResult): string =>
  ((value(result).job as Record<string, unknown>).id as string)

describe('the tools against a provider that is not consult', () => {
  it('mounts at all: a second implementation satisfies the abstract service', async () => {
    const harness = await setup()
    const capabilities = await harness.ctx.delegation.capabilities()
    assert.equal(capabilities.ready, true)
    assert.deepEqual([...capabilities.profiles], ['toy'])
    assert.equal(capabilities.canSteer, false)
    assert.equal(capabilities.canReport, false)
    // Every tool the consult composition registers is registered here too.
    const names = harness.ctx.tools.schemas().map((schema) => schema.name).filter((name) => name.startsWith('delegate'))
    assert.deepEqual(names.sort(), ['delegate', 'delegate_logs', 'delegate_result', 'delegate_review', 'delegate_status', 'delegate_steer'])
  })

  it('delegates, tracks a background job, and completes', async () => {
    const harness = await setup({ delayMs: 20 })
    const owner = harness.owner('toy-session-1')
    const started = await harness.call('delegate', { prompt: 'transform this', label: 'toy run' }, owner.agent)
    const jobId = startedJobId(started)
    assert.equal(value(started).kind, 'started')
    const backgroundJobId = value(started).backgroundJobId as string
    assert.equal(typeof backgroundJobId, 'string', 'the jobs integration is provider-independent')
    assert.match(text(started), /Tracked as background job/)

    const snapshot = await harness.ctx.jobs.wait(JobId(backgroundJobId), 20_000, owner.agent)
    assert.equal(snapshot.status, 'completed')
    assert.match(snapshot.detail ?? '', new RegExp(`delegate_result ${jobId}`))
  })

  it('reports lifecycle through delegate_status', async () => {
    const harness = await setup({ delayMs: 400 })
    const owner = harness.owner('toy-session-2')
    const jobId = startedJobId(await harness.call('delegate', { prompt: 'slow one' }, owner.agent))

    const live = value(await harness.call('delegate_status', { job_id: jobId }))
    const liveStatus = ((live.jobs as Array<Record<string, unknown>>)[0]?.status) as string
    assert.ok(liveStatus === 'queued' || liveStatus === 'running', `unexpected live status ${liveStatus}`)

    await until(() => {
      const jobs = harness.ctx.jobs.list(owner.agent)
      return jobs.every((job) => job.status !== 'running') ? true : undefined
    })
    const done = value(await harness.call('delegate_status', { job_id: jobId }))
    assert.equal(((done.jobs as Array<Record<string, unknown>>)[0]?.status), 'completed')
  })

  it('refuses a result before the delegation finalizes, then serves it', async () => {
    const harness = await setup({ delayMs: 400 })
    const owner = harness.owner('toy-session-3')
    const jobId = startedJobId(await harness.call('delegate', { prompt: 'patience' }, owner.agent))

    const early = await harness.call('delegate_result', { job_id: jobId })
    assert.equal(early.isError, false, 'not-final is a domain outcome on any provider')
    assert.equal(value(early).code, 'not-final')

    const [settled] = await harness.ctx.delegation.wait([jobId], 20_000)
    assert.equal(settled?.status, 'completed')

    const result = await harness.call('delegate_result', { job_id: jobId })
    assert.equal(value(result).kind, 'result')
    assert.match(value(result).finalText as string, /toy delegate answered: patience/)
    // The consumer's untrusted-data framing is provider-independent.
    assert.match(text(result), /<untrusted-delegate-output job="toy-1">/)
    assert.match(text(result), /a claim, not a verified fact/)
  })

  it('serves a bounded transcript tail', async () => {
    const harness = await setup({ delayMs: 20 })
    const owner = harness.owner('toy-session-4')
    const jobId = startedJobId(await harness.call('delegate', { prompt: 'log me' }, owner.agent))
    await harness.ctx.delegation.wait([jobId], 20_000)
    const logs = await harness.call('delegate_logs', { job_id: jobId, tail: 10 })
    assert.match(value(logs).text as string, /running/)
    assert.match(text(logs), /transcript tail/)
  })

  it('cancels a running delegation', async () => {
    const harness = await setup({ delayMs: 30_000 })
    const owner = harness.owner('toy-session-5')
    const jobId = startedJobId(await harness.call('delegate', { prompt: 'never mind' }, owner.agent))
    await harness.ctx.delegation.cancel(jobId)
    const [statusJob] = await harness.ctx.delegation.status(jobId)
    assert.equal(statusJob?.status, 'cancelled')
    const result = await harness.call('delegate_result', { job_id: jobId })
    assert.equal(value(result).kind, 'result')
    assert.equal((value(result).job as Record<string, unknown>).status, 'cancelled')
  })

  it('answers delegate_steer with the unsupported outcome, not an error', async () => {
    const harness = await setup({ delayMs: 30_000 })
    const owner = harness.owner('toy-session-6')
    const jobId = startedJobId(await harness.call('delegate', { prompt: 'go left' }, owner.agent))
    const steered = await harness.call('delegate_steer', { job_id: jobId, guidance: 'go right instead' })
    assert.equal(steered.isError, false)
    assert.equal(value(steered).outcome, 'unsupported')
    assert.match(text(steered), /cannot be steered at all/)
    assert.match(text(steered), /job_kill/)
    await harness.ctx.delegation.cancel(jobId)
  })

  it('stays silent when the provider has no upward events', async () => {
    const harness = await setup({ delayMs: 200 })
    const owner = harness.owner('toy-session-7')
    await harness.call('delegate', { prompt: 'quiet please' }, owner.agent)
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.deepEqual([...owner.injected, ...owner.followedUp], [], 'no events means no notices, not a crash')
    const page = await harness.ctx.delegation.events('toy-1')
    assert.equal(page.supported, false)
    assert.deepEqual([...page.events], [])
    assert.equal(typeof harness.ctx.delegation.watch('toy-1', () => {}), 'function')
  })

  it('surfaces a provider that cannot review as a domain outcome', async () => {
    const harness = await setup()
    const review = await harness.call('delegate_review', { base: 'main' })
    assert.equal(review.isError, false)
    assert.equal(value(review).code, 'review-unsupported')
    assert.match(text(review), /\[review-unsupported]/)
  })

  it('reports a truncated answer as truncated, whichever layer dropped the bytes', async () => {
    // Two layers can shorten an answer: the stdout collector, which keeps a
    // tail silently, and the model-facing bound, which keeps the head and says
    // what it dropped. A caller must never be handed a short answer that claims
    // to be complete, so the flag has to be true if EITHER fired.
    const harness = await setup({ delayMs: 20, maxTextBytes: 256 })
    const owner = harness.owner('toy-session-8')

    // Over the model-facing budget, under the collector's: the bound truncates.
    const modest = startedJobId(await harness.call('delegate', { prompt: 'm'.repeat(300) }, owner.agent))
    await harness.ctx.delegation.wait([modest], 20_000)
    const bounded = value(await harness.call('delegate_result', { job_id: modest }))
    assert.equal(bounded.finalTextTruncated, true)
    assert.match(bounded.finalText as string, /more bytes not shown/)

    // Over BOTH: the collector slid first, and the loss is still reported.
    const huge = startedJobId(await harness.call('delegate', { prompt: 'h'.repeat(4_000) }, owner.agent))
    await harness.ctx.delegation.wait([huge], 20_000)
    const dropped = value(await harness.call('delegate_result', { job_id: huge }))
    assert.equal(dropped.finalTextTruncated, true)
    // The collector is sized above the model-facing budget precisely so the
    // marker is still written by the layer that keeps the head.
    assert.match(dropped.finalText as string, /more bytes not shown/)
    assert.ok(Buffer.byteLength(dropped.finalText as string, 'utf8') < 512)
  })

  it('leaves an answer that fits marked as complete', async () => {
    const harness = await setup({ delayMs: 20, maxTextBytes: 4_000 })
    const owner = harness.owner('toy-session-9')
    const jobId = startedJobId(await harness.call('delegate', { prompt: 'short' }, owner.agent))
    await harness.ctx.delegation.wait([jobId], 20_000)
    const result = value(await harness.call('delegate_result', { job_id: jobId }))
    assert.equal(result.finalTextTruncated, false)
    assert.equal(/not shown/.test(result.finalText as string), false)
  })

  it('surfaces spec fields the provider cannot honor instead of ignoring them', async () => {
    // The seam's DelegateSpec carries options a provider may have no notion of.
    // Refusing is the honest answer; silently dropping `isolated` would let a
    // supervisor believe its edits were sandboxed when they were not.
    const harness = await setup()
    const isolated = await harness.call('delegate', { prompt: 'p', mode: 'write', isolated: true })
    assert.equal(isolated.isError, false)
    assert.equal(value(isolated).code, 'unsupported')
    assert.match(text(isolated), /no workspace to detach/)
  })
})
