// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { HTTP } from "../lib/http-status";
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:

const MIN_MODEL_ID_LENGTH = 3; // AIモデル識別子の最小文字数

//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { getConfigStub, getConfiguredDomains } from "../lib/config";

export const adminApp = new Hono<{ Bindings: Env }>();

// ── Domains (read-only — managed in wrangler.jsonc) ───────────────

adminApp.get(
  "/api/inbox/v1/admin/domains",
  /** Lists configured domains and reports storage failures. */ async (c) => {
    try {
      return c.json({ domains: await getConfiguredDomains(c.env) });
    } catch (err) {
      console.error("[listConfiguredDomains] failed", { err });
      throw err;
    }
  },
);

// ── Addresses (dynamic registration in ConfigDO) ──────────────────

adminApp.get(
  "/api/inbox/v1/admin/addresses",
  /** adminApp.get /api/inbox/v1/admin/addresses のコールバックを実行します。 */ async (c) => {
    try {
      const config = getConfigStub(c.env);
      const addresses = await config.listAddresses();
      return await c.json({ addresses });
    } catch (err) {
      console.error("[routes.adminApp.get /api/inbox/v1/admin/addresses] 失敗", {
        context: { operation: "adminApp.get /api/inbox/v1/admin/addresses", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

const AddAddressBody = z.object({ email: z.string().email() });

adminApp.post(
  "/api/inbox/v1/admin/addresses",
  /** adminApp.post /api/inbox/v1/admin/addresses のコールバックを実行します。 */ async (c) => {
    try {
      const { email } = AddAddressBody.parse(await c.req.json());
      const config = getConfigStub(c.env);
      const result = await config.addAddress(email, await getConfiguredDomains(c.env));
      if (!result.ok) return await c.json({ error: result.error }, HTTP.BAD_REQUEST);
      return await c.json({ email: result.email }, HTTP.CREATED);
    } catch (err) {
      console.error("[routes.adminApp.post /api/inbox/v1/admin/addresses] 失敗", {
        context: { operation: "adminApp.post /api/inbox/v1/admin/addresses", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

adminApp.delete(
  "/api/inbox/v1/admin/addresses/:email",
  /** adminApp.delete /api/inbox/v1/admin/addresses/:email のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const email = decodeURIComponent(c.req.param("email")!);
      const config = getConfigStub(c.env);
      await config.removeAddress(email);
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error("[routes.adminApp.delete /api/inbox/v1/admin/addresses/:email] 失敗", {
        context: {
          operation: "adminApp.delete /api/inbox/v1/admin/addresses/:email",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

const ToggleBody = z.object({ enabled: z.boolean() });

adminApp.patch(
  "/api/inbox/v1/admin/addresses/:email",
  /** adminApp.patch /api/inbox/v1/admin/addresses/:email のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const email = decodeURIComponent(c.req.param("email")!);
      const { enabled } = ToggleBody.parse(await c.req.json());
      const config = getConfigStub(c.env);
      await config.setAddressEnabled(email, enabled);
      return await c.body(null, HTTP.NO_CONTENT);
    } catch (err) {
      console.error("[routes.adminApp.patch /api/inbox/v1/admin/addresses/:email] 失敗", {
        context: {
          operation: "adminApp.patch /api/inbox/v1/admin/addresses/:email",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

// ── AI model selection ────────────────────────────────────────────

const KNOWN_MODELS = [
  "@cf/moonshotai/kimi-k2.5",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/openai/gpt-oss-120b",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
] as const;

adminApp.get(
  "/api/inbox/v1/admin/ai",
  /** adminApp.get /api/inbox/v1/admin/ai のコールバックを実行します。 */ async (c) => {
    try {
      const config = getConfigStub(c.env);
      const model = (await config.getSetting("ai_model")) || "@cf/moonshotai/kimi-k2.5";
      return await c.json({ model, knownModels: KNOWN_MODELS });
    } catch (err) {
      console.error("[routes.adminApp.get /api/inbox/v1/admin/ai] 失敗", {
        context: { operation: "adminApp.get /api/inbox/v1/admin/ai", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

const AIBody = z.object({ model: z.string().min(MIN_MODEL_ID_LENGTH) });

adminApp.put(
  "/api/inbox/v1/admin/ai",
  /** adminApp.put /api/inbox/v1/admin/ai のコールバックを実行します。 */ async (c) => {
    try {
      const { model } = AIBody.parse(await c.req.json());
      const config = getConfigStub(c.env);
      await config.setSetting("ai_model", model);
      return await c.json({ model });
    } catch (err) {
      console.error("[routes.adminApp.put /api/inbox/v1/admin/ai] 失敗", {
        context: { operation: "adminApp.put /api/inbox/v1/admin/ai", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

// ── Spam allow/block list ─────────────────────────────────────────

const ListBody = z.object({ list: z.enum(["allow", "block"]), entry: z.string().min(1) });

adminApp.post(
  "/api/inbox/v1/admin/spam-list",
  /** adminApp.post /api/inbox/v1/admin/spam-list のコールバックを実行します。 */ async (c) => {
    try {
      const { list, entry } = ListBody.parse(await c.req.json());
      const config = getConfigStub(c.env);
      await config.addToList(list, entry);
      return await c.json({ ok: true }, HTTP.CREATED);
    } catch (err) {
      console.error("[routes.adminApp.post /api/inbox/v1/admin/spam-list] 失敗", {
        context: { operation: "adminApp.post /api/inbox/v1/admin/spam-list", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);

adminApp.delete(
  "/api/inbox/v1/admin/spam-list",
  /** adminApp.delete /api/inbox/v1/admin/spam-list のコールバックを実行します。 */ async (c) => {
    try {
      const { list, entry } = ListBody.parse(await c.req.json());
      const config = getConfigStub(c.env);
      await config.removeFromList(list, entry);
      return await c.json({ ok: true });
    } catch (err) {
      console.error("[routes.adminApp.delete /api/inbox/v1/admin/spam-list] 失敗", {
        context: { operation: "adminApp.delete /api/inbox/v1/admin/spam-list", parameterCount: 1 },
        err,
      });
      throw err;
    }
  },
);
