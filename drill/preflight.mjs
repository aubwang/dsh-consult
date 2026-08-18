import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ConsultDelegation } from '/home/dev/dsh-consult/lib/provider.js'

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(ConsultDelegation, {
  consultPath: 'node',
  consultArgs: ['/home/dev/consult/bin/consult'],
  cwd: '/home/dev/consult',
})
console.log('local 1.0.0 consult:', JSON.stringify(await ctx.delegation.capabilities(), null, 1))

const stale = new Context()
await stale.plugin(LocalSubprocessRuntime)
await stale.plugin(ConsultDelegation, { consultPath: 'consult', cwd: '/home/dev/consult' })
const staleCaps = await stale.delegation.capabilities()
console.log('global stale consult:', JSON.stringify(staleCaps, null, 1))
process.exit(0)
