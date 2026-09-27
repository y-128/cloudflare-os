// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeTarget } from './uploader'

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

describe('writeTarget', () => {
  it('sends presigned PUTs as signed, without Photos credentials', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    localStorage.setItem('authToken', 'admin:secret')
    await writeTarget({ kind: 'presigned-put', url: 'https://bucket.example/k?X-Amz-Signature=x', headers: { 'Content-Type': 'image/jpeg' }, expiresAt: 0 }, new Blob(['a']), 'image/jpeg')
    const [, init] = fetchMock.mock.calls[0]
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBeNull()
    expect(headers.get('Content-Type')).toBe('image/jpeg')
  })

  it('splits multipart targets into their parts, each authenticated', async () => {
    const bodies: number[] = []
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (_url, init) => {
      bodies.push((init.body as Blob).size)
      expect(new Headers(init.headers).get('X-Photos-Request')).toBe('1')
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await writeTarget({ kind: 'multipart', partUrls: ['/p?part=1', '/p?part=2', '/p?part=3'], partSize: 4, expiresAt: 0 }, new Blob(['0123456789']), 'image/tiff')
    expect(bodies).toEqual([4, 4, 2])
  })

  it('fails loudly on a rejected write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    await expect(writeTarget({ kind: 'worker-proxy', url: '/x', expiresAt: 0 }, new Blob(['a']), 'image/jpeg')).rejects.toThrow('403')
  })
})
