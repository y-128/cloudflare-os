/**
 * Renders an unknown thrown value as a readable string for logs.
 *
 * `console.error("...", { err })` looks right but is a trap in the Workers runtime: an `Error`
 * has no enumerable own properties, so it serializes to `{}` and the log says nothing. That has
 * repeatedly cost time here — a failing Cloudflare API call reported only `err: {}`, and the
 * cause had to be found by redeploying with different logging.
 *
 * Pass the result of this instead of the error itself.
 */

// A stack trace is useful but unbounded; keep enough frames to locate the throw.
const MAX_STACK_LENGTH = 800;

/** Formats a thrown value as `Name: message`, appending a bounded stack when one exists. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err === "string" ? err : JSON.stringify(err) ?? String(err);
  const head = `${err.name}: ${err.message}`;
  // `cause` carries the real reason when a wrapper error is rethrown.
  const cause = err.cause === undefined ? "" : ` (cause: ${describeError(err.cause)})`;
  const stack = err.stack ? `\n${err.stack.slice(0, MAX_STACK_LENGTH)}` : "";
  return `${head}${cause}${stack}`;
}
