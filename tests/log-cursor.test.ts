/**
 * Cursor semantics for turning a bounded, re-fetched transcript tail into the
 * consuming delta `ctx.jobs`' synchronous `readOutput` hook requires.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { advanceLogCursor } from '../src/log-cursor.ts'

describe('advanceLogCursor', () => {
  it('emits the whole window on the first read', () => {
    const advance = advanceLogCursor(undefined, 'a\nb\nc\n')
    assert.equal(advance.delta, 'a\nb\nc')
    assert.equal(advance.anchor, 'c')
    assert.equal(advance.gap, false)
  })

  it('consumes: an unchanged transcript yields nothing the second time', () => {
    const first = advanceLogCursor(undefined, 'a\nb\nc\n')
    const second = advanceLogCursor(first.anchor, 'a\nb\nc\n')
    assert.equal(second.delta, '')
    assert.equal(second.anchor, 'c')
    assert.equal(second.gap, false)
  })

  it('emits only the lines appended since the previous read', () => {
    const first = advanceLogCursor(undefined, 'a\nb\n')
    const second = advanceLogCursor(first.anchor, 'a\nb\nc\nd\n')
    assert.equal(second.delta, 'c\nd')
    assert.equal(second.anchor, 'd')
    assert.equal(second.gap, false)
  })

  it('reports a gap when the anchor slid out of the window instead of guessing', () => {
    const first = advanceLogCursor(undefined, 'a\nb\n')
    const second = advanceLogCursor(first.anchor, 'x\ny\nz\n')
    assert.equal(second.gap, true)
    assert.equal(second.delta, 'x\ny\nz')
    assert.equal(second.anchor, 'z')
  })

  it('anchors on the most recent occurrence of a repeated line', () => {
    const advance = advanceLogCursor('tick', 'tick\nnoise\ntick\nafter\n')
    assert.equal(advance.delta, 'after')
    assert.equal(advance.anchor, 'after')
  })

  it('treats an empty transcript as no progress and keeps the anchor', () => {
    assert.deepEqual(advanceLogCursor('a', ''), { delta: '', anchor: 'a', gap: false })
    assert.deepEqual(advanceLogCursor('a', '\n\n'), { delta: '', anchor: 'a', gap: false })
    assert.deepEqual(advanceLogCursor(undefined, ''), { delta: '', gap: false })
  })
})
