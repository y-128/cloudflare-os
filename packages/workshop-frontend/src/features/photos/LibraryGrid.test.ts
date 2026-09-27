import { describe, expect, it } from 'vitest'
import type { PhotoId } from '../../../../photos/shared/ids'
import { nextSelection } from './LibraryGrid'

const [a, b, c, d] = ['pho_a', 'pho_b', 'pho_c', 'pho_d'] as PhotoId[]
const order = [a, b, c, d]

describe('nextSelection', () => {
  it('replaces on a plain click and toggles on a modified one', () => {
    expect(nextSelection([a, b], order, a, c, 'replace')).toEqual([c])
    expect(nextSelection([a], order, a, c, 'toggle')).toEqual([a, c])
    expect(nextSelection([a, c], order, a, c, 'toggle')).toEqual([a])
  })

  it('extends a range from the anchor in either direction', () => {
    expect(nextSelection([b], order, b, d, 'range')).toEqual([b, c, d])
    expect(nextSelection([d], order, d, b, 'range')).toEqual([d, b, c])
    expect(nextSelection([], order, null, c, 'range')).toEqual([c])
  })
})
