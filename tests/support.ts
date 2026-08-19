/**
 * Test helpers shared by every suite that drives the model-facing tools through
 * a real Cordis composition: a fake supervisor agent, a tool caller, a bounded
 * poll, and the two result projections.
 *
 * Nothing provider-specific lives here — that is the point. `tools.test.ts`
 * drives the consult provider and `seam-portability.test.ts` drives the toy
 * one, and both compose the tools the same way.
 * @module tests/support
 */

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** How one fake owner behaves when a notice arrives. */
export interface FakeDelivery {
  /** Defaults to `running` — the lane that never wakes — so a test pins one lane deliberately. */
  status?: 'idle' | 'running'
}

/** One event a fake session recorded, for suites that assert on the log. */
export interface RecordedSessionEvent {
  type: string
  data: unknown
}

/** A supervisor whose two delivery lanes a test can inspect. */
export interface FakeOwner {
  agent: Agent
  injected: UserMessage[]
  followedUp: UserMessage[]
  /** Log-only events appended through the session (commands write their lifecycle here). */
  appended: RecordedSessionEvent[]
  /** Simulate the owner claiming human input, which refills the wake budget. */
  claimUserInput(): void
}

/** Calls one registered tool, optionally on behalf of an agent. */
export type ToolCaller = (name: string, args: Record<string, unknown>, agent?: Agent) => Promise<ToolExecutionResult>

const callSignal = new AbortController().signal
let callSequence = 0

/**
 * Build a tool caller bound to one context.
 * @param ctx - the composition holding the tool registry.
 * @returns a function that executes a tool by name.
 */
export function toolCaller(ctx: Context): ToolCaller {
  return (name, args, agent) => ctx.tools.execute({
    callId: CallId(`call-${(callSequence += 1)}`),
    name,
    arguments: args,
    signal: callSignal,
    ...agent !== undefined ? { agent } : {},
  })
}

/**
 * Register a fake supervisor in the context's agent registry.
 * @param ctx - the composition to register into.
 * @param sessionId - the agent/session identity.
 * @param delivery - how the owner behaves when a notice arrives.
 * @returns the owner and a disposer for its registration and scope.
 */
export function registerOwner(
  ctx: Context,
  sessionId: string,
  delivery: FakeDelivery = {},
): { owner: FakeOwner; dispose: () => Promise<void> } {
  const injected: UserMessage[] = []
  const followedUp: UserMessage[] = []
  const appended: RecordedSessionEvent[] = []
  const scope = ctx.plugin(() => {})
  const id = SessionId(sessionId)
  let seq = 0
  const agent = {
    id,
    ctx: scope.ctx,
    status: delivery.status ?? 'running',
    inject: (message: UserMessage) => injected.push(message),
    followup: (message: UserMessage) => followedUp.push(message),
    session: {
      id,
      header: { version: 0, id, createdAt: 0 },
      // ctx.commands writes its own command/run and command/done lifecycle
      // records through the session, so a fake one has to accept them.
      append: (type: string, data: unknown) => {
        appended.push({ type, data })
        return { type, data, seq: (seq += 1), time: Date.now() }
      },
    },
  } as unknown as Agent
  const detach = ctx.agents.register(agent)
  return {
    owner: {
      agent,
      injected,
      followedUp,
      appended,
      claimUserInput: () => ctx.emit('agent/inbox/claimed', {
        agent,
        message: { source: { kind: 'user' } } as unknown as UserMessage,
        turn: 1,
      }),
    },
    dispose: async () => {
      detach()
      await scope.dispose()
    },
  }
}

/**
 * Poll a predicate on a short bounded budget.
 * @param probe - returns the awaited value, or undefined to keep waiting.
 * @param timeoutMs - budget before the wait fails.
 * @returns whatever the probe first returned.
 */
export async function until<T>(probe: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = probe()
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condition was not met within the budget')
}

/**
 * Assert a tool call succeeded and return its canonical value.
 * @param result - the materialized tool outcome.
 * @returns the canonical value as a record.
 */
export function value(result: ToolExecutionResult): Record<string, unknown> {
  assert.equal(result.isError, false, `expected success, got ${JSON.stringify(result.error)}`)
  return result.value as Record<string, unknown>
}

/**
 * Join a tool result's model-facing text blocks.
 * @param result - the materialized tool outcome.
 * @returns the rendered text.
 */
export function text(result: ToolExecutionResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
}
