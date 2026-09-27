import { createLogger } from "@gadgets/backend-utils/logger";
import { PHOTOS_REQUEST_HEADER } from "../shared/api-types";
import type { PhotosEnv } from "./env";

const logger = createLogger<{ status?: number }>({ component: "photos.auth" });

/** The only request headers forwarded to the Workshop: credentials and cross-site context. */
const FORWARDED_HEADERS = ["Authorization", "cf-access-jwt-assertion", "Origin", PHOTOS_REQUEST_HEADER];

/**
 * Asks the Workshop whether the request comes from an administrator, returning who it acts for.
 * The WORKSHOP_AUTH binding is deployment-owned; nothing the client sends grants authority by
 * itself. Any failure is a denial.
 */
export async function authenticateAdmin(request: Request, env: PhotosEnv): Promise<string | null> {
  const url = new URL(request.url);
  url.pathname = "/api/photos-auth";
  url.search = "";
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await env.WORKSHOP_AUTH.fetch(new Request(url, { method: "GET", headers }));
    if (response.status !== 200) return null;
    const body: unknown = await response.json();
    const actor = (body as { actor?: unknown } | null)?.actor;
    return typeof actor === "string" && actor ? actor : null;
  } catch (err) {
    logger.error("workshop authentication unavailable", { event: "photos.auth.unavailable", error: err });
    return null;
  }
}

/** Whether the credential key secret is present and decodes to 32 bytes. */
export function hasValidCredentialKey(env: PhotosEnv): boolean {
  try {
    return env.PHOTOS_CREDENTIAL_KEY !== undefined && atob(env.PHOTOS_CREDENTIAL_KEY).length === 32;
  } catch {
    return false;
  }
}
