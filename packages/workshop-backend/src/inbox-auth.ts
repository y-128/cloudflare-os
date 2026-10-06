import type { CfAccessEnv } from './access'
import { authorizeAdminServiceRequest, type AdminServiceCredentials } from './admin-service-auth'

const FORBIDDEN = 403 // Fail closed for unauthenticated and unauthorized callers alike.

/** Produces a non-cacheable denial without disclosing the account admission result. */
const forbidden = () => new Response(null, { status: FORBIDDEN, headers: { 'Cache-Control': 'no-store' } })

/** Authorizes mail through existing cfos credentials and its administrator capability. */
export const authorizeInboxRequest = async (
  request: Request,
  env: CfAccessEnv,
  authenticate: (credentials: AdminServiceCredentials) => Promise<boolean>,
): Promise<Response> => {
  const admin = await authorizeAdminServiceRequest(request, env, 'X-Inbox-Request', authenticate)
  return admin ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : forbidden()
}

/** Authorizes Photos the same way, returning the administrator it acts for as `{ actor }`. */
export const authorizePhotosRequest = async (
  request: Request,
  env: CfAccessEnv,
  authenticate: (credentials: AdminServiceCredentials) => Promise<boolean>,
): Promise<Response> => {
  const admin = await authorizeAdminServiceRequest(request, env, 'X-Photos-Request', authenticate)
  return admin ? Response.json(admin, { headers: { 'Cache-Control': 'no-store' } }) : forbidden()
}
