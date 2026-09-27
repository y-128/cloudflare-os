import { createLogger } from "@gadgets/backend-utils/logger";
import type { JWTPayload } from "jose";
import { verifyCfAccessJwt, type CfAccessEnv } from "./access";

/** Credentials forwarded by a first-party service, checked by the existing RPC authentication. */
export type AdminServiceCredentials = { access?: JWTPayload; token?: string };

const logger = createLogger<{ marker?: string }>({ component: "workshop.admin-service-auth" });

/**
 * Checks a request a first-party service (the mailbox, Photos) forwarded on behalf of a browser,
 * and returns the administrator it acts for, or null. `authenticate` must resolve true only for
 * an administrator; any failure, including a thrown one, is a denial.
 *
 * Access cookies are ambient credentials, so the browser must also send `requestMarker: 1` (a
 * non-simple header that cross-site forms and embeds cannot set) and any Origin must match.
 */
export async function authorizeAdminServiceRequest(
  request: Request,
  env: CfAccessEnv,
  requestMarker: string,
  authenticate: (credentials: AdminServiceCredentials) => Promise<boolean>,
): Promise<{ actor: string } | null> {
  const origin = request.headers.get("Origin");
  if (request.headers.get(requestMarker) !== "1" || (origin && origin !== new URL(request.url).origin)) {
    return null;
  }
  try {
    let credentials: AdminServiceCredentials;
    let actor: string;
    if (env.CF_ACCESS_AUD) {
      const access = await verifyCfAccessJwt(request, env);
      if (!access || typeof access.email !== "string" || !access.email) return null;
      credentials = { access };
      actor = access.email;
    } else {
      const authorization = request.headers.get("Authorization");
      if (!authorization?.startsWith("Bearer ")) return null;
      const token = authorization.slice("Bearer ".length);
      credentials = { token };
      // The session token is `<user>:<secret>`; the user half is trusted only once it verifies.
      actor = token.split(":")[0];
    }
    return await authenticate(credentials) ? { actor } : null;
  } catch (err) {
    logger.warn("admin service authorization failed", {
      event: "admin-service-auth.failed", marker: requestMarker, error: err,
    });
    return null;
  }
}
