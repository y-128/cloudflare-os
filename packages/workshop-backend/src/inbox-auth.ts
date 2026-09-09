import { verifyCfAccessJwt, type CfAccessEnv } from './access'
import type { JWTPayload } from 'jose'

const FORBIDDEN = 403 // Fail closed for unauthenticated and unauthorized callers alike.

/** Authorizes mail through existing cfos credentials and its administrator capability. */
export const authorizeInboxRequest = async (
  request: Request,
  env: CfAccessEnv,
  authenticate: (credentials: { access?: JWTPayload; token?: string }) => Promise<boolean>,
): Promise<Response> => {
  /** Produces a non-cacheable denial without disclosing the account admission result. */
  const forbidden = () => new Response(null, { status: FORBIDDEN, headers: { 'Cache-Control': 'no-store' } })
  // Access cookies are ambient credentials. A non-simple header prevents cross-site forms and
  // embeds from causing reads or writes; explicit origins must also match the public request URL.
  const origin = request.headers.get('Origin')
  if (request.headers.get('X-Inbox-Request') !== '1' || (origin && origin !== new URL(request.url).origin)) return forbidden()
  try {
    let credentials: { access?: JWTPayload; token?: string }
    if (env.CF_ACCESS_AUD) {
      const access = await verifyCfAccessJwt(request, env)
      if (!access || typeof access.email !== 'string' || !access.email) return forbidden()
      credentials = { access }
    } else {
      const authorization = request.headers.get('Authorization')
      if (!authorization?.startsWith('Bearer ')) return forbidden()
      credentials = { token: authorization.slice('Bearer '.length) }
    }
    if (!await authenticate(credentials)) return forbidden()
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[authorizeInboxRequest] failed', { err })
    return forbidden()
  }
}
