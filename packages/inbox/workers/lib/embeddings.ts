// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { requireBinding } from "./bindings";
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:

const DEFAULT_SEARCH_RESULTS = 20; // 意味検索の既定取得件数

//     https://opensource.org/licenses/Apache-2.0

/**
 * Vectorize integration for semantic email search.
 *
 * Embeddings come from Workers AI (default `@cf/baai/bge-m3`, 1024 dim,
 * multilingual). Each mailbox lives under its own namespace.
 */

import { ConfigurationError } from "./config";
import type { Env } from "../types";

const EMBED_MODEL = "@cf/baai/bge-m3";
const MAX_TEXT_BYTES = 4 * 1024; // 埋め込みモデルへ渡す最大UTF-8バイト数

type Vectorize = VectorizeIndex | undefined;

/** index の処理を実行します。 */ function index(env: Env): Vectorize {
  return env.VECTORIZE;
}

/** truncate の処理を実行します。 */ function truncate(text: string): string {
  if (!text) return "";
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  if (bytes.length <= MAX_TEXT_BYTES) return text;
  const sliced = bytes.subarray(0, MAX_TEXT_BYTES);
  return new TextDecoder().decode(sliced);
}

/** embed の処理を実行します。 */ async function embed(
  env: Env,
  text: string,
): Promise<number[] | null> {
  try {
    try {
      const res = (await requireBinding(env, "AI").run(EMBED_MODEL, { text: [truncate(text)] })) as
        | { data: number[][] }
        | { data: number[] };
      const arr = Array.isArray(res.data?.[0])
        ? (res as { data: number[][] }).data[0]
        : (res as { data: number[] }).data;
      return await (Array.isArray(arr) ? arr : null);
    } catch (e) {
      console.error("[embed] 失敗", { context: { operation: "embed" }, err: e });

      throw e;
    }
  } catch (err) {
    console.error("[lib.embed] 失敗", { context: { operation: "embed", parameterCount: 2 }, err });
    throw err;
  }
}

/** upsertEmail の処理を実行します。 */ export async function upsertEmail(
  env: Env,
  mailboxId: string,
  email: { id: string; subject: string; sender: string; date: string; body_text: string },
): Promise<boolean> {
  try {
    const idx = index(env);
    if (!idx) return false;
    const text = `${email.subject}\n\n${email.body_text}`.trim();
    const vector = await embed(env, text);
    if (!vector) return false;
    await idx.upsert([
      {
        id: email.id,
        namespace: mailboxId,
        values: vector,
        metadata: { subject: email.subject, sender: email.sender, date: email.date },
      },
    ]);
    return true;
  } catch (err) {
    console.error("[lib.upsertEmail] 失敗", {
      context: { operation: "upsertEmail", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

/** deleteEmailVector の処理を実行します。 */ export async function deleteEmailVector(
  env: Env,
  mailboxId: string,
  emailId: string,
): Promise<void> {
  try {
    const idx = index(env);
    if (!idx) return;
    try {
      await idx.deleteByIds([emailId]);
    } catch (caught) {
      console.error("[deleteEmailVector] 失敗", {
        context: { operation: "deleteEmailVector" },
        err: caught,
      });

      // ignore
    }
    void mailboxId;
  } catch (err) {
    console.error("[lib.deleteEmailVector] 失敗", {
      context: { operation: "deleteEmailVector", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

/** semanticSearch の処理を実行します。 */ export async function semanticSearch(
  env: Env,
  mailboxId: string,
  query: string,
  topK = DEFAULT_SEARCH_RESULTS,
): Promise<{ id: string; score: number }[]> {
  try {
    const idx = index(env);
    if (!idx)
      throw new ConfigurationError(
        "VECTORIZEが未設定です。意味検索を使用する場合はpackages/inbox/wrangler.jsoncのvectorizeバインディングを設定してください。",
      );
    const vector = await embed(env, query);
    if (!vector) return [];
    const res = await idx.query(vector, { topK, namespace: mailboxId, returnMetadata: false });
    return await res.matches.map(
      /** res.matches.map callback のコールバックを実行します。 */ (m) => ({
        id: m.id,
        score: m.score,
      }),
    );
  } catch (err) {
    console.error("[lib.semanticSearch] 失敗", {
      context: { operation: "semanticSearch", parameterCount: 4 },
      err,
    });
    throw err;
  }
}
