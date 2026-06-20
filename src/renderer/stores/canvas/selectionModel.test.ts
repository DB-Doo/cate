// =============================================================================
// selectionModel / canonical-selection invariant.
//
// The canvas selection is one ordered array (`selection`) plus an
// `selectionActive` flag; the active/focused node is DERIVED as the lead of the
// selection. This makes the rendered set (selection rings + the active halo) and
// the moved set (a group drag translates `selection`) the same thing — a node
// can never render as focused/selected yet sit outside the moved set, which was
// the "what's selected vs what moves don't match" bug.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { createCanvasStore } from '../canvasStore'
import { focusedNodeId, isSelected, withLead } from './selectionModel'

function addThree() {
  const store = createCanvasStore()
  const a = store.getState().addNode('a', 'terminal', { x: 0, y: 0 }, { width: 100, height: 80 })
  const b = store.getState().addNode('b', 'terminal', { x: 200, y: 0 }, { width: 100, height: 80 })
  const c = store.getState().addNode('c', 'terminal', { x: 400, y: 0 }, { width: 100, height: 80 })
  return { store, a, b, c }
}

/** The core invariant: the derived focused node is always null or a member of
 *  the selection — never a node outside the moved set. */
function expectInvariant(state: { selection: string[]; selectionActive: boolean }) {
  const f = focusedNodeId(state)
  if (f !== null) expect(state.selection).toContain(f)
}

describe('focusedNodeId derivation', () => {
  it('is the lead (last) of the selection only while activated', () => {
    expect(focusedNodeId({ selection: [], selectionActive: false })).toBeNull()
    expect(focusedNodeId({ selection: ['x'], selectionActive: false })).toBeNull()
    expect(focusedNodeId({ selection: ['x'], selectionActive: true })).toBe('x')
    expect(focusedNodeId({ selection: ['x', 'y'], selectionActive: true })).toBe('y')
  })
})

describe('withLead', () => {
  it('appends as lead, de-duping and preserving the rest in order', () => {
    expect(withLead(['a', 'b', 'c'], 'b')).toEqual(['a', 'c', 'b'])
    expect(withLead(['a'], 'z')).toEqual(['a', 'z'])
  })
})

describe('canonical selection invariant', () => {
  it('focusNode collapses to a single active selection (focused is in selection)', () => {
    const { store, b } = addThree()
    store.getState().focusNode(b)
    const s = store.getState()
    expect(s.selection).toEqual([b])
    expect(focusedNodeId(s)).toBe(b)
    expectInvariant(s)
  })

  it('a marquee-style multi-selection has NO active node — glow set == selection == moved set', () => {
    const { store, a, b } = addThree()
    store.getState().selectNodes([a, b])
    const s = store.getState()
    expect(s.selection).toEqual([a, b])
    // No focused node → every selected node renders the same (ring), and the
    // group drag (which moves `selection`) moves exactly the glowing set.
    expect(focusedNodeId(s)).toBeNull()
    expect(isSelected(s, a)).toBe(true)
    expect(isSelected(s, b)).toBe(true)
    expectInvariant(s)
  })

  it('the old divergence is gone: focusing then marquee-selecting elsewhere drops the stale focus', () => {
    const { store, a, b, c } = addThree()
    // Activate A (it would have rendered a halo under the old model)...
    store.getState().focusNode(a)
    expect(focusedNodeId(store.getState())).toBe(a)
    // ...then marquee a different set. Previously A kept its halo while sitting
    // outside the selection (looked selected, didn't move). Now there is no
    // focused node outside the moved set.
    store.getState().selectNodes([b, c])
    const s = store.getState()
    expect(focusedNodeId(s)).toBeNull()
    expect(isSelected(s, a)).toBe(false)
    expect(s.selection).toEqual([b, c])
    expectInvariant(s)
  })

  it('removing the active node deactivates and drops it from the selection', () => {
    const { store, a } = addThree()
    store.getState().focusNode(a)
    store.getState().removeNode(a)
    const s = store.getState()
    expect(s.selection).not.toContain(a)
    expect(focusedNodeId(s)).toBeNull()
    expectInvariant(s)
  })

  it('toggle builds a multi-selection with no active lead', () => {
    const { store, a, b } = addThree()
    store.getState().focusNode(a)
    store.getState().toggleNodeSelection(b)
    const s = store.getState()
    expect(new Set(s.selection)).toEqual(new Set([a, b]))
    expect(focusedNodeId(s)).toBeNull()
    expectInvariant(s)
  })
})
