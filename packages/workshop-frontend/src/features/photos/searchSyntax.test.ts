import { describe, expect, it } from 'vitest'
import { parseSearch } from './searchSyntax'

describe('parseSearch', () => {
  it('turns fields and comparisons into a structured query', () => {
    expect(parseSearch('camera:"ILCE-7M4" lens:35mm iso<=800 f<2.8 shutter<=1/500 raw:yes fav')).toEqual({
      cameraModels: ['ILCE-7M4'],
      lensModels: ['35mm'],
      hasRaw: true,
      favorite: true,
      numeric: [
        { field: 'iso', op: 'lte', value: 800 },
        { field: 'fNumber', op: 'lt', value: 2.8 },
        { field: 'exposureTimeS', op: 'lte', value: 0.002 },
      ],
    })
  })

  it('covers whole days for date ranges', () => {
    const { takenFrom, takenTo } = parseSearch('from:2026-09-01 to:2026-09-01')
    expect(takenFrom).toBe(new Date(2026, 8, 1).getTime())
    expect(takenTo! - takenFrom!).toBe(24 * 60 * 60 * 1000 - 1)
  })

  it('keeps anything it does not understand as free text', () => {
    expect(parseSearch('sunset "golden hour" iso<=abc owner:me raw:maybe')).toEqual({
      text: 'sunset golden hour iso<=abc owner:me raw:maybe',
    })
    expect(parseSearch('   ')).toEqual({})
  })
})
