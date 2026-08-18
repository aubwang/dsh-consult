/**
 * Smoke probe: prove the bundle actually loads inside a real dsh composition.
 *
 * Mounted alongside the plugin through a --patch overlay, it waits for the
 * composition to settle, prints the model-visible tool names, and exits before
 * the harness reaches the LLM (so the drill needs no API key).
 *
 * Usage, from the deepseek-harness checkout:
 *   pnpm dsh --profile headless --patch /home/dev/dsh-consult/drill/smoke.patch.yml "probe"
 */

export const name = 'drill-list-tools'
export const inject = ['tools']

const DEADLINE_MS = 10_000

export function apply(ctx) {
  const started = Date.now()
  const timer = setInterval(() => {
    const names = ctx.tools.schemas().map((schema) => schema.name).sort()
    const delegation = names.filter((n) => n === 'delegate' || n.startsWith('delegate_'))
    if (delegation.length < 6 && Date.now() - started < DEADLINE_MS) return
    clearInterval(timer)
    process.stdout.write(`[drill] visible tools: ${names.join(', ')}\n`)
    process.stdout.write(`[drill] delegation tools: ${delegation.join(', ') || '(none)'}\n`)
    process.exit(delegation.length === 6 ? 0 : 1)
  }, 25)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))
}
