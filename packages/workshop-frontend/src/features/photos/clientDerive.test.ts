import { describe, expect, it } from 'vitest'
import { normalizeExif } from '../../../../photos/shared/exif'
import { fit, formatFamily, sha256File } from './clientDerive'

describe('formatFamily', () => {
  it('recognizes RAW by extension and common formats by extension or type', () => {
    expect(formatFamily({ name: 'DSC00001.ARW', type: '' })).toBe('raw')
    expect(formatFamily({ name: 'x.jpeg', type: '' })).toBe('jpeg')
    expect(formatFamily({ name: 'noext', type: 'image/png' })).toBe('png')
    expect(formatFamily({ name: 'IMG_1.HEIC', type: '' })).toBe('heif')
    expect(formatFamily({ name: 'notes.txt', type: 'text/plain' })).toBe('other')
  })
})

describe('normalizeExif', () => {
  it('keeps the fields Photos searches and drops malformed ones', () => {
    const exif = normalizeExif({
      DateTimeOriginal: new Date(Date.UTC(2026, 8, 1, 3)), OffsetTimeOriginal: '+09:00',
      Make: ' SONY ', Model: 'ILCE-7M4', FNumber: 2.8, ExposureTime: 0.002, ISO: 100.4,
      Flash: 16, Orientation: 9, latitude: 35.6, longitude: 139.7, Artist: '',
    })
    expect(exif).toEqual({
      takenAt: Date.UTC(2026, 8, 1, 3), timezoneOffsetMin: 540, make: 'SONY', model: 'ILCE-7M4',
      fNumber: 2.8, exposureTimeS: 0.002, iso: 100, flashFired: false, gps: { lat: 35.6, lon: 139.7 },
    })
    expect(normalizeExif({ Flash: 'Fired' })?.flashFired).toBe(true)
    expect(normalizeExif({})).toBeUndefined()
  })
})

describe('fit', () => {
  it('shrinks the long edge to the limit without enlarging', () => {
    expect(fit(6048, 4024, 2048)).toEqual({ width: 2048, height: 1363 })
    expect(fit(4024, 6048, 400)).toEqual({ width: 266, height: 400 })
    expect(fit(300, 200, 400)).toEqual({ width: 300, height: 200 })
  })
})

describe('sha256File', () => {
  it('hashes across chunk boundaries like a one-shot digest', async () => {
    const bytes = new Uint8Array(9 * 1024 * 1024).map((_, i) => i % 251)
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(b => b.toString(16).padStart(2, '0')).join('')
    expect(await sha256File(new Blob([bytes]))).toBe(expected)
  })
})
