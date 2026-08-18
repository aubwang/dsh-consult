/**
 * Package entry point for `@aubwang/dsh-consult`. The three plugin modules are
 * loaded by the bundle patch under their own subpaths; this root re-exports the
 * seam vocabulary so a library consumer can `import type { DelegateSpec } from
 * '@aubwang/dsh-consult'` without choosing a subpath.
 * @module @aubwang/dsh-consult
 */

export * from './seam.ts'
export { ConsultDelegation, type Config as ConsultDelegationConfig } from './provider.ts'
