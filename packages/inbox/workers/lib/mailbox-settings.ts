import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { canonicalize, normalizeAddress } from "../../shared/email-address";
import type { Env } from "../types";
import { requireBinding } from "./bindings";
import { describeError } from "./describe-error";
import { HTTP } from "./http-status";

/** Display names are single-line header values; an empty name clears the setting. */
export const FromNameSchema = z.string().refine(value => !/[\r\n]/.test(value) && !value.includes("\0")).transform(value => value.trim());
/** Validates incoming settings while retaining fields owned by other mailbox features. */
export const MailboxSettingsSchema = z.object({ fromName: FromNameSchema.optional() }).passthrough();
const StoredSettingsSchema = z.record(z.unknown());
const SETTINGS_WRITE_ATTEMPTS = 3;

/** Reads the original R2 settings, retaining fields owned by other mailbox features. */
export async function readMailboxSettings(env: Env, mailboxId: string) {
  try {
    const object = await requireBinding(env, "BUCKET").get(`mailboxes/${canonicalize(mailboxId)}.json`);
    const settings = object ? StoredSettingsSchema.parse(await object.json()) : {};
    const name = FromNameSchema.optional().safeParse(settings.fromName);
    if (!name.success) console.error("[readMailboxSettings] failed", { err: describeError(new Error("Invalid stored sender display name")) });
    return { ...settings, fromName: name.success ? name.data : "" };
  } catch (err) {
    console.error("[readMailboxSettings] failed", { err: describeError(err) });
    throw err;
  }
}

/** Resolves the configured name without changing the validated sender address or its plus tag. */
export async function resolveMailboxFrom(env: Env, email: string): Promise<{ email: string; name: string }> {
  // Address validation must never be swallowed by the optional metadata fallback.
  const address = normalizeAddress(email);
  try {
    const settings = await readMailboxSettings(env, email);
    return { email: address, name: settings.fromName ?? "" };
  } catch {
    // readMailboxSettings already records the failed I/O without logging settings.
    return { email: address, name: "" };
  }
}

/** Replaces settings only if the object has not changed since this request read its ETag. */
export async function writeMailboxSettings(env: Env, mailboxId: string, value: unknown) {
  try {
    const settings = MailboxSettingsSchema.parse(value);
    const bucket = requireBinding(env, "BUCKET");
    const key = `mailboxes/${canonicalize(mailboxId)}.json`;
    const object = await bucket.head(key);
    if (!object) throw new HTTPException(HTTP.NOT_FOUND, { message: "Mailbox not found" });
    if (!await bucket.put(key, JSON.stringify(settings), { onlyIf: { etagMatches: object.etag } })) {
      throw new HTTPException(HTTP.CONFLICT, { message: "Mailbox settings changed; reload and retry" });
    }
    return settings;
  } catch (err) {
    console.error("[writeMailboxSettings] failed", { err: describeError(err) });
    throw err;
  }
}

/** Retries a name-only update against fresh snapshots so concurrent settings are retained. */
export async function writeMailboxFromName(env: Env, mailboxId: string, value: string): Promise<string> {
  try {
    const fromName = FromNameSchema.parse(value);
    const bucket = requireBinding(env, "BUCKET");
    const key = `mailboxes/${canonicalize(mailboxId)}.json`;
    for (let attempt = 0; attempt < SETTINGS_WRITE_ATTEMPTS; attempt++) {
      const object = await bucket.get(key);
      if (!object) throw new HTTPException(HTTP.NOT_FOUND, { message: "Mailbox not found" });
      // Validate the container, not the old name: malformed legacy names must be repairable.
      const settings = StoredSettingsSchema.parse(await object.json());
      if (await bucket.put(key, JSON.stringify({ ...settings, fromName }), {
        onlyIf: { etagMatches: object.etag },
      })) return fromName;
    }
    throw new HTTPException(HTTP.CONFLICT, { message: "Mailbox settings changed; reload and retry" });
  } catch (err) {
    console.error("[writeMailboxFromName] failed", { err: describeError(err) });
    throw err;
  }
}
