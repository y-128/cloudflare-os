import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JWTPayload } from 'jose'
import { authorizeInboxRequest, authorizePhotosRequest } from '../src/inbox-auth'

const verify = vi.hoisted(() => vi.fn<() => Promise<JWTPayload | null>>())
vi.mock('../src/access', () => ({ verifyCfAccessJwt: verify }))

/** Constructs a browser-style request without putting credentials into its URL. */
const request = (headers: Record<string, string> = {}) => new Request('https://cfos.example/api/inbox-auth', { headers: { 'X-Inbox-Request': '1', ...headers } })
beforeEach(() => verify.mockReset())

describe('inbox reuses cfos authentication', () => {
  it('passes the existing session to the authority check and requires admin permission', async () => {
    const authenticate = vi.fn<(credentials: { access?: JWTPayload; token?: string }) => Promise<boolean>>().mockResolvedValue(true)
    expect((await authorizeInboxRequest(request({ Authorization: 'Bearer user:secret' }), {}, authenticate)).status).toBe(204)
    expect(authenticate).toHaveBeenCalledWith({ token: 'user:secret' })
    authenticate.mockResolvedValue(false)
    expect((await authorizeInboxRequest(request({ Authorization: 'Bearer user:secret' }), {}, authenticate)).status).toBe(403)
  })
  it('rejects missing credentials and expired sessions', async () => {
    const authenticate = vi.fn<(credentials: { access?: JWTPayload; token?: string }) => Promise<boolean>>().mockRejectedValue(new Error('Expired session'))
    expect((await authorizeInboxRequest(request(), {}, authenticate)).status).toBe(403)
    expect(authenticate).not.toHaveBeenCalled()
    expect((await authorizeInboxRequest(request({ Authorization: 'Bearer expired:secret' }), {}, authenticate)).status).toBe(403)
  })
  it('uses verified Access claims, never falling back to a bearer token in Access mode', async () => {
    const authenticate = vi.fn<(credentials: { access?: JWTPayload; token?: string }) => Promise<boolean>>().mockResolvedValue(true)
    const env = { CF_ACCESS_AUD: 'shared-aud', CF_ACCESS_ISS: 'https://team.cloudflareaccess.com' }
    verify.mockResolvedValue({ email: 'admin@example.com' })
    expect((await authorizeInboxRequest(request(), env, authenticate)).status).toBe(204)
    expect(authenticate).toHaveBeenCalledWith({ access: { email: 'admin@example.com' } })
    verify.mockResolvedValue(null)
    expect((await authorizeInboxRequest(request({ Authorization: 'Bearer user:secret' }), env, authenticate)).status).toBe(403)
  })
  it('rejects cross-site forms, forged origins and backend failures without caching permission', async () => {
    const authenticate = vi.fn<(credentials: { access?: JWTPayload; token?: string }) => Promise<boolean>>().mockResolvedValue(true)
    expect((await authorizeInboxRequest(request({ 'X-Inbox-Request': '', Authorization: 'Bearer user:secret' }), {}, authenticate)).status).toBe(403)
    const response = await authorizeInboxRequest(request({ Origin: 'https://evil.example', Authorization: 'Bearer user:secret' }), {}, authenticate)
    expect(response.status).toBe(403)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(authenticate).not.toHaveBeenCalled()
  })
})

/** Constructs a Photos request carrying its own request marker. */
const photosRequest = (headers: Record<string, string> = {}) => new Request('https://cfos.example/api/photos-auth', { headers: { 'X-Photos-Request': '1', ...headers } })

describe('photos reuses the same administrator check', () => {
  it('names the verified administrator so Photos can record who edited what', async () => {
    const authenticate = vi.fn<(credentials: { access?: JWTPayload; token?: string }) => Promise<boolean>>().mockResolvedValue(true)
    const response = await authorizePhotosRequest(photosRequest({ Authorization: 'Bearer alice:secret' }), {}, authenticate)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ actor: 'alice' })
    expect(authenticate).toHaveBeenCalledWith({ token: 'alice:secret' })
  })
  it('names the Access identity in Access mode', async () => {
    const authenticate = vi.fn<(credentials: { access?: JWTPayload; token?: string }) => Promise<boolean>>().mockResolvedValue(true)
    verify.mockResolvedValue({ email: 'admin@example.com' })
    const env = { CF_ACCESS_AUD: 'shared-aud', CF_ACCESS_ISS: 'https://team.cloudflareaccess.com' }
    expect(await (await authorizePhotosRequest(photosRequest(), env, authenticate)).json()).toEqual({ actor: 'admin@example.com' })
  })
  it('denies non-administrators without naming them', async () => {
    const authenticate = vi.fn<(credentials: { access?: JWTPayload; token?: string }) => Promise<boolean>>().mockResolvedValue(false)
    const response = await authorizePhotosRequest(photosRequest({ Authorization: 'Bearer bob:secret' }), {}, authenticate)
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('')
  })
  it('does not accept the mailbox marker in place of its own', async () => {
    const authenticate = vi.fn<(credentials: { access?: JWTPayload; token?: string }) => Promise<boolean>>().mockResolvedValue(true)
    const crossed = new Request('https://cfos.example/api/photos-auth', { headers: { 'X-Inbox-Request': '1', Authorization: 'Bearer alice:secret' } })
    expect((await authorizePhotosRequest(crossed, {}, authenticate)).status).toBe(403)
    expect(authenticate).not.toHaveBeenCalled()
  })
})
