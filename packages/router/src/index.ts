import { bufferEmail, type BufferedEmail, type EmailReceiver, type GadgetEmailReceiver } from "@gadgets/backend-utils/email-delivery";

// The public origin of a gadgets instance. Routes by path prefix to the workshop backend and
// whichever gatekeepers are bound, and serves the workshop frontend for everything else.
//
// Routing config IS the binding set: gatekeepers are discovered by scanning `GATEKEEPER_*` env
// keys, so installing a gatekeeper only requires re-deploying this worker with one more service
// binding — no code or config changes here.
//
// The same worker doubles as the dev router (`pnpm dev-server` at the repo root): dev has no
// `ASSETS` binding, so frontend requests fall through to the backend instead.

// gatekeeper-email's entrypoint: a WorkerEntrypoint whose optional email() handler is present.
type EmailEntrypoint = CloudflareWorkersModule.WorkerEntrypoint &
    Required<Pick<CloudflareWorkersModule.WorkerEntrypoint, "email">>;

export interface Env {
  WORKSHOP_BACKEND: Fetcher;
  /** Present in production (wrangler.jsonc assets stanza); absent in dev. */
  ASSETS?: Fetcher;
  /** Dormant until custom domains + Email Routing exist; the handler ships anyway. */
  GATEKEEPER_EMAIL?: Service<EmailEntrypoint & GadgetEmailReceiver>;
  /** Static mailbox service; optional for legacy deployments and local development. */
  MAIL_INBOX?: Service<CloudflareWorkersModule.WorkerEntrypoint & EmailReceiver>;
  [key: string]: unknown;
}

export default {
  /** Route a request to its bound service or the existing asset/backend fallback. */
  async fetch(req, env) {
    try {
      const url = new URL(req.url);

      for (const key of Object.keys(env)) {
        if (!key.startsWith("GATEKEEPER_")) continue;
        const suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
        const prefix = `/gatekeeper/${suffix}`;
        if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
          return await (env[key] as Fetcher).fetch(req);
        }
      }

      // Gatekeeper routes above are disjoint; inbox MUST precede the generic /api route below.
      // Otherwise /api/inbox/* would silently reach WORKSHOP_BACKEND instead of the mailbox.
      if (env.MAIL_INBOX && (url.pathname === "/api/inbox" ||
          url.pathname.startsWith("/api/inbox/"))) {
        return await env.MAIL_INBOX.fetch(req);
      }

      if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
          url.pathname === "/blueprint-screenshot" ||
          url.pathname.startsWith("/blueprint-screenshot/")) {
        return await env.WORKSHOP_BACKEND.fetch(req);
      }

      // Note: gatekeeper OAuth redirects land on the gatekeeper Workers themselves, at
      // `/gatekeeper/<name>/oauth` (handled by the loop above) — there are no backend /auth
      // callbacks.

      if (env.ASSETS) {
        return await env.ASSETS.fetch(req);
      }

      // Dev only: with no assets binding here, everything else goes to the backend.
      //
      // In `run-local` mode the backend has a static `assets` binding configured (with
      // `run_worker_first` for the API routes), so it serves the pre-built single-page app for these
      // frontend requests. In normal dev mode the backend has no assets and frontend requests aren't
      // expected here -- run the Vite dev server with `pnpm dev-client` and open localhost:3000
      // directly instead. (We don't try to forward to localhost:3000 becaues it doesn't work well:
      // Vite's HMR socket gets disconnected every time wrangler restarts workerd.)
      return await env.WORKSHOP_BACKEND.fetch(req);
    } catch (err) {
      console.error("[router.fetch] failed", { method: req.method, err });
      throw err;
    }
  },

  /** Deliver to the mailbox of record and independently to an enabled Gadget hook. */
  async email(message, env) {
    if (!env.MAIL_INBOX) {
      if (!env.GATEKEEPER_EMAIL) {
        message.setReject("No email gatekeeper is installed on this instance.");
        return;
      }
      try {
        await env.GATEKEEPER_EMAIL.email(message);
      } catch (err) {
        console.error("[router.email] failed", { destination: "gatekeeper", err });
        throw err;
      }
      return;
    }

    let payload: BufferedEmail;
    try {
      payload = await bufferEmail(message);
    } catch (err) {
      console.error("[router.email] failed", { operation: "buffer", rawSize: message.rawSize, err });
      message.setReject("Unable to read inbound email.");
      return;
    }

    let inboxAccepted = false;
    let rejectionReason = "Email delivery failed.";
    try {
      const result = await env.MAIL_INBOX.deliverEmail(payload);
      inboxAccepted = result.accepted;
      if (!result.accepted) rejectionReason = result.reason;
    } catch (err) {
      console.error("[router.email] failed", { destination: "inbox", rawSize: message.rawSize, err });
    }

    let gadgetAccepted = false;
    if (env.GATEKEEPER_EMAIL) {
      try {
        if (await env.GATEKEEPER_EMAIL.hasEmailHook(payload.to)) {
          const result = await env.GATEKEEPER_EMAIL.deliverEmail(payload);
          gadgetAccepted = result.accepted;
        }
      } catch (err) {
        console.error("[router.email] failed", { destination: "gatekeeper", rawSize: message.rawSize, err });
      }
    }
    if (!inboxAccepted && !gadgetAccepted) message.setReject(rejectionReason);
  },
} satisfies ExportedHandler<Env>;
