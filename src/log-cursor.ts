/**
 * A consuming cursor over an append-only rendered transcript that is only
 * readable as a bounded tail.
 *
 * `ctx.jobs`' `readOutput` hook is synchronous and consuming, while the
 * delegation seam exposes the transcript as an asynchronous bounded tail. The
 * bridge is an anchor: remember the last line already handed to the model, and
 * on the next tail emit everything after the most recent occurrence of that
 * line. When the anchor has slid out of the window the read is reported as a
 * gap rather than silently replaying or silently skipping.
 *
 * @module @aubwang/dsh-consult/log-cursor
 */

/** One cursor advance over a freshly fetched tail. */
export interface LogAdvance {
  /** Lines rendered since the previous advance. */
  delta: string
  /** Anchor to pass to the next advance. */
  anchor?: string
  /** True when the previous anchor was no longer inside the window. */
  gap: boolean
}

/**
 * Advance the cursor over a newly fetched transcript tail.
 * @param anchor - the last line emitted by the previous advance; undefined on the first read.
 * @param tail - the freshly fetched bounded tail.
 * @returns the unseen lines, the next anchor, and whether the window overflowed.
 */
export function advanceLogCursor(anchor: string | undefined, tail: string): LogAdvance {
  const lines = tail.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) {
    return { delta: '', ...anchor !== undefined ? { anchor } : {}, gap: false }
  }
  const last = lines[lines.length - 1] as string
  if (anchor === undefined) {
    return { delta: lines.join('\n'), anchor: last, gap: false }
  }
  const index = lines.lastIndexOf(anchor)
  if (index === -1) {
    return { delta: lines.join('\n'), anchor: last, gap: true }
  }
  const fresh = lines.slice(index + 1)
  if (fresh.length === 0) return { delta: '', anchor, gap: false }
  return { delta: fresh.join('\n'), anchor: fresh[fresh.length - 1] as string, gap: false }
}
