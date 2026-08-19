/**
 * The reviewer is consumer #2 on the delegation seam, and its value is as much
 * about what it CANNOT see as what it does. These tests drive it over both
 * providers — the consult one through the fake CLI, and the toy one which has
 * no review capability at all — and guard the import graph that makes running
 * over both possible.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { ConsultDelegation, type Config as ProviderConfig } from '../src/provider.ts'
import { ToyDelegation } from '../src/toy-provider.ts'
import * as Reviewer from '../src/reviewer.ts'
import { registerOwner, until, type FakeOwner } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-consult.mjs', import.meta.url))
const REVIEWER_SOURCE = fileURLToPath(new URL('../src/reviewer.ts', import.meta.url))

interface Harness {
  ctx: Context
  owner: FakeOwner
  run(line: string): Promise<CommandResult>
  invocations(): Array<{ argv: string[] }>
}

const teardown: Array<() => Promise<void>> = []
const signal = new AbortController().signal

/**
 * How the composition provides background jobs:
 * `attached` mounts a registry with a controller; `none` mounts no registry at
 * all; `unattached` mounts one whose `start` refuses because no controller
 * serves the owner.
 */
type JobsMode = 'attached' | 'none' | 'unattached'

/** Mount the reviewer over the consult provider driven by the fake CLI. */
async function setupConsult(
  scenario: Record<string, string> = {},
  provider: Partial<ProviderConfig> = {},
  reviewer: Reviewer.Config = {},
  jobsMode: JobsMode = 'attached',
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-consult-reviewer-'))
  const record = join(dir, 'record.jsonl')
  writeFileSync(record, '')
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(CommandRuntime),
    await ctx.plugin(LocalSubprocessRuntime),
    await ctx.plugin(AgentRegistry),
  ]
  if (jobsMode !== 'none') fibers.push(await ctx.plugin(LocalJobRegistry))
  if (jobsMode === 'attached') ctx.jobs.attachController('test')
  fibers.push(await ctx.plugin(ConsultDelegation, {
    consultPath: process.execPath,
    consultArgs: [FIXTURE],
    cwd: dir,
    graceMs: 500,
    env: { FAKE_CONSULT_STATE: join(dir, 'state.json'), FAKE_CONSULT_RECORD: record, ...scenario },
    ...provider,
  }))
  fibers.push(await ctx.plugin(Reviewer, reviewer))
  const registered = registerOwner(ctx, 'reviewer-session', { status: 'running' })
  teardown.push(registered.dispose)
  teardown.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  return {
    ctx,
    owner: registered.owner,
    run: async (line) => (await ctx.commands.execute(registered.owner.agent, line, signal))!.result,
    invocations: () => readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] }),
  }
}

/** Mount the same reviewer over a provider that has no review capability. */
async function setupToy(): Promise<Harness> {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(CommandRuntime),
    await ctx.plugin(LocalSubprocessRuntime),
    await ctx.plugin(AgentRegistry),
    await ctx.plugin(LocalJobRegistry),
  ]
  ctx.jobs.attachController('test')
  fibers.push(await ctx.plugin(ToyDelegation, { delayMs: 20 }))
  fibers.push(await ctx.plugin(Reviewer, {}))
  const registered = registerOwner(ctx, 'reviewer-toy-session', { status: 'running' })
  teardown.push(registered.dispose)
  teardown.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  return {
    ctx,
    owner: registered.owner,
    run: async (line) => (await ctx.commands.execute(registered.owner.agent, line, signal))!.result,
    invocations: () => [],
  }
}

after(async () => {
  for (const dispose of teardown) await dispose()
})

const bodyOf = (message: { content: Array<{ text?: string }> }): string =>
  message.content.map((block) => block.text ?? '').join('\n')

describe('seam purity', () => {
  it('imports the seam and nothing from any provider', () => {
    // The reviewer exists to prove the seam is usable from outside the code
    // that grew up with it. An import of the consult adapter, either provider,
    // or the delegation tools would quietly end that proof, so the graph is
    // asserted rather than trusted.
    const source = readFileSync(REVIEWER_SOURCE, 'utf8')
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] as string)
    const forbidden = specifiers.filter((specifier) =>
      /consult-cli|\.\/provider|toy-provider|\.\/tools/.test(specifier))
    assert.deepEqual(forbidden, [], `reviewer.ts reached past the seam: ${forbidden.join(', ')}`)
    // …and it really does depend on the seam.
    assert.ok(specifiers.includes('./seam.ts'), 'reviewer.ts should consume the seam types')
    const local = specifiers.filter((specifier) => specifier.startsWith('.'))
    assert.deepEqual(local.sort(), ['./bounds.ts', './render.ts', './seam.ts'],
      'only provider-neutral local modules are allowed')
  })
})

describe('/review over the consult provider', () => {
  it('queues a review and reports what it queued', async () => {
    const harness = await setupConsult({ FAKE_CONSULT_STATUS: 'queued' })
    const result = await harness.run('/review main')
    assert.equal(result.kind, 'success')
    assert.match(result.text ?? '', /Review of changes since main queued as job-1/)
    assert.match(result.text ?? '', /findings will be added to this session/)
    assert.match(result.text ?? '', /job_kill review-1/)
    const review = harness.invocations().find((entry) => entry.argv[0] === 'review')
    assert.deepEqual(review?.argv.slice(0, 5), ['review', '--background', '--json', '--base', 'main'])
  })

  it('reviews the provider\'s own default target when given no base', async () => {
    const harness = await setupConsult({ FAKE_CONSULT_STATUS: 'queued' })
    const result = await harness.run('/review')
    assert.match(result.text ?? '', /Review of the current change queued/)
    const review = harness.invocations().find((entry) => entry.argv[0] === 'review')
    assert.equal(review?.argv.includes('--base'), false, 'no base means the provider decides')
  })

  it('uses the configured base and reviewer selectors', async () => {
    const harness = await setupConsult({ FAKE_CONSULT_STATUS: 'queued' }, {}, {
      defaultBase: 'origin/main',
      profile: 'codex',
      model: 'sonnet',
      effort: 'high',
    })
    await harness.run('/review')
    const argv = harness.invocations().find((entry) => entry.argv[0] === 'review')?.argv ?? []
    assert.deepEqual(argv.slice(argv.indexOf('--base'), argv.indexOf('--base') + 2), ['--base', 'origin/main'])
    assert.deepEqual(argv.slice(argv.indexOf('--agent'), argv.indexOf('--agent') + 2), ['--agent', 'codex'])
    assert.ok(argv.includes('--model') && argv.includes('--effort'))
  })

  it('delivers the findings into the session that asked for them', async () => {
    const harness = await setupConsult({ FAKE_CONSULT_FINAL_TEXT: 'FINDING: the retry helper swallows errors' })
    await harness.run('/review main')
    const notice = await until(() => harness.owner.injected[0])
    const body = bodyOf(notice as unknown as { content: Array<{ text?: string }> })
    assert.match(body, /FINDING: the retry helper swallows errors/)
    // Findings are a delegate's words about the human's code.
    assert.match(body, /<untrusted-delegate-output job="job-1">/)
    assert.match(body, /a claim about the code, not a verdict/)
    const summary = (notice.source as { summary?: string }).summary ?? ''
    assert.ok(summary.length > 0 && summary.length <= 120)
    assert.equal(harness.owner.followedUp.length, 0, 'a human-triggered review never opens a turn on its own')
  })

  it('reports a review that ended badly instead of inventing findings', async () => {
    const harness = await setupConsult({
      FAKE_CONSULT_STATUS: 'failed',
      FAKE_CONSULT_ERROR_MESSAGE: 'the reviewer ran out of context',
    })
    await harness.run('/review main')
    const notice = await until(() => harness.owner.injected[0])
    const body = bodyOf(notice as unknown as { content: Array<{ text?: string }> })
    assert.match(body, /ended as failed and produced no findings/)
    assert.match(body, /ran out of context/)
  })

  it('tells the human plainly when delegation is not ready, and queues nothing', async () => {
    const harness = await setupConsult({ FAKE_CONSULT_VERSION: '0.12.0' })
    const result = await harness.run('/review main')
    assert.equal(result.kind, 'error')
    assert.match(result.text ?? '', /Delegation is not available/)
    assert.match(result.text ?? '', />=1\.0\.0 <2\.0\.0/)
    assert.equal(harness.invocations().some((entry) => entry.argv[0] === 'review'), false)
  })

  it('reports a provider that refuses the review as a domain outcome', async () => {
    const harness = await setupConsult({ FAKE_CONSULT_EXIT_REVIEW: '8' })
    const result = await harness.run('/review main')
    assert.equal(result.kind, 'error')
    assert.match(result.text ?? '', /\[review-unsupported]/)
  })
})

describe('/review over a provider with no review capability', () => {
  it('answers cleanly instead of throwing', async () => {
    // The payoff of making review an OPTIONAL seam capability: the same
    // consumer runs unchanged over a provider that simply does not have it.
    const harness = await setupToy()
    assert.equal((await harness.ctx.delegation.capabilities()).canReview, false)
    const result = await harness.run('/review main')
    assert.equal(result.kind, 'error')
    assert.match(result.text ?? '', /serves no reviews/)
    assert.match(result.text ?? '', /Nothing was queued/)
    assert.deepEqual(harness.owner.injected, [])
  })

  it('still registers the command, so the human gets an answer rather than an unknown command', async () => {
    const harness = await setupToy()
    const names = harness.ctx.commands.list(harness.owner.agent).map((command) => command.name)
    assert.ok(names.includes('review'))
  })
})

describe('collection does not depend on a job registry', () => {
  // The reply promises that findings will arrive. Collection is what keeps
  // that promise, so it cannot be conditional on registration succeeding.
  it('delivers findings with no job registry mounted, and promises nothing it cannot do', async () => {
    const harness = await setupConsult(
      { FAKE_CONSULT_FINAL_TEXT: 'FINDING: unbounded retry loop' }, {}, {}, 'none',
    )
    const result = await harness.run('/review main')
    assert.equal(result.kind, 'success')
    assert.equal(/job_kill/.test(result.text ?? ''), false, 'no job exists, so none is offered')
    assert.match(result.text ?? '', /not registered as a background job/)
    const notice = await until(() => harness.owner.injected[0])
    assert.match(bodyOf(notice as unknown as { content: Array<{ text?: string }> }), /FINDING: unbounded retry loop/)
  })

  it('delivers findings when job registration itself fails', async () => {
    // A registry with no attached controller refuses `start`, which is the
    // realistic shape of registration failure.
    const harness = await setupConsult(
      { FAKE_CONSULT_FINAL_TEXT: 'FINDING: swallowed error' }, {}, {}, 'unattached',
    )
    const result = await harness.run('/review main')
    assert.equal(result.kind, 'success')
    assert.equal(/job_kill/.test(result.text ?? ''), false)
    const notice = await until(() => harness.owner.injected[0])
    assert.match(bodyOf(notice as unknown as { content: Array<{ text?: string }> }), /FINDING: swallowed error/)
  })
})

describe('findings are bounded before they enter the session', () => {
  it('truncates an oversized review with a marker', async () => {
    const harness = await setupConsult(
      { FAKE_CONSULT_FINAL_TEXT: 'F'.repeat(40_000) },
      // The provider's own budget is deliberately larger, so the reviewer's cap
      // is the one doing the work.
      { maxTextBytes: 32_000 },
      { maxNoticeBytes: 512 },
    )
    await harness.run('/review main')
    const notice = await until(() => harness.owner.injected[0])
    const body = bodyOf(notice as unknown as { content: Array<{ text?: string }> })
    assert.match(body, /more bytes not shown/)
    assert.ok(Buffer.byteLength(body, 'utf8') < 1_500, `notice was ${Buffer.byteLength(body, 'utf8')} bytes`)
  })

  it('leaves a review that fits untouched', async () => {
    const harness = await setupConsult(
      { FAKE_CONSULT_FINAL_TEXT: 'FINDING: one small thing' }, {}, { maxNoticeBytes: 4_000 },
    )
    await harness.run('/review main')
    const notice = await until(() => harness.owner.injected[0])
    const body = bodyOf(notice as unknown as { content: Array<{ text?: string }> })
    assert.match(body, /FINDING: one small thing/)
    assert.equal(/not shown/.test(body), false)
  })
})
