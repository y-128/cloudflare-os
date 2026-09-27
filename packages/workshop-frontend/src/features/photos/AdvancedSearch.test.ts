import { describe, expect, it } from 'vitest'
import { numericBound, withNumericBound } from './AdvancedSearch'
import { formatSearch } from './searchSyntax'

describe('numeric bounds', () => {
  it('sets, replaces and clears one side of a range', () => {
    let query = withNumericBound({}, 'iso', 'lte', '800')
    query = withNumericBound(query, 'iso', 'gte', '100')
    query = withNumericBound(query, 'iso', 'lte', '1600')
    expect(numericBound(query, 'iso', 'lte')).toBe('1600')
    expect(formatSearch(query)).toBe('iso>=100 iso<=1600')
    query = withNumericBound(withNumericBound(query, 'iso', 'gte', ''), 'iso', 'lte', 'abc')
    expect(query.numeric).toBeUndefined()
  })
})
