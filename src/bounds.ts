/**
 * Bounding helpers, provider-neutral by construction.
 *
 * Every provider owes the seam the same guarantee — no delegate can spend the
 * supervisor's context by writing a long answer — so these live in their own
 * leaf rather than inside the consult adapter that happened to need them first.
 * A second provider importing its truncation rules from `consult-cli.ts` would
 * be a small lie about what is provider-specific.
 * @module @aubwang/dsh-consult/bounds
 */

/** Result of bounding one text field. */
export interface BoundedText {
  text: string
  truncated: boolean
}

/**
 * Truncate text to a UTF-8 byte budget without splitting a code point,
 * appending a marker when bytes were dropped.
 * @param text - the untrusted input.
 * @param maxBytes - byte budget for the retained text.
 * @param keep - retain the `head` (answers read forwards) or the `tail` (logs read backwards).
 * @returns the bounded text and whether anything was dropped.
 */
export function boundText(text: string, maxBytes: number, keep: 'head' | 'tail'): BoundedText {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return { text, truncated: false }
  const dropped = buffer.byteLength - maxBytes
  if (keep === 'head') {
    const kept = new TextDecoder('utf8', { fatal: false }).decode(buffer.subarray(0, maxBytes)).replace(/�+$/, '')
    return { text: `${kept}\n[truncated: ${dropped} more bytes not shown]`, truncated: true }
  }
  const kept = new TextDecoder('utf8', { fatal: false }).decode(buffer.subarray(buffer.byteLength - maxBytes)).replace(/^�+/, '')
  return { text: `[truncated: ${dropped} earlier bytes not shown]\n${kept}`, truncated: true }
}

/**
 * Keep the last `maxLines` lines of text within a byte budget.
 * @param text - the untrusted input.
 * @param maxLines - line budget.
 * @param maxBytes - byte budget applied after the line budget.
 * @returns the bounded tail.
 */
export function boundLines(text: string, maxLines: number, maxBytes: number): BoundedText {
  // A rendered transcript ends with a newline; that trailing empty element is a
  // line terminator, not a line, and must not consume the budget.
  const lines = text.replace(/\n$/, '').split('\n')
  const droppedLines = Math.max(0, lines.length - maxLines)
  const kept = droppedLines === 0 ? text : lines.slice(droppedLines).join('\n')
  const bounded = boundText(kept, maxBytes, 'tail')
  return { text: bounded.text, truncated: bounded.truncated || droppedLines > 0 }
}

/**
 * Bound a structured event payload by re-encoding it and, when it does not
 * fit, replacing it with the bounded text of its own encoding — a supervisor
 * that cannot have the whole object is better served by a readable prefix than
 * by a silently pruned object it might reason about as complete.
 * @param data - the delegate-authored payload.
 * @param maxBytes - byte budget for its JSON encoding.
 * @returns the payload, or a bounded string standing in for it.
 */
export function boundJson(data: unknown, maxBytes: number): unknown {
  let encoded: string
  try {
    encoded = JSON.stringify(data) ?? 'null'
  } catch {
    return '[unencodable delegate data]'
  }
  if (Buffer.byteLength(encoded, 'utf8') <= maxBytes) return data
  return boundText(encoded, maxBytes, 'head').text
}
