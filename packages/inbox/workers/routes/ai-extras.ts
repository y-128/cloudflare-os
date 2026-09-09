// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { HTTP } from "../lib/http-status";
import { requireBinding } from "../lib/bindings";
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:

const THREAD_MESSAGE_CHARS = 1500; // 要約に渡す一通の最大文字数
const TRANSLATION_CHARS = 8000; // 翻訳する本文の最大文字数
const MAX_INSTRUCTION_CHARS = 2000; // 草稿指示の最大文字数
const DRAFT_INPUT_CHARS = 6000; // 草稿作成に渡す本文の最大文字数
const SEARCH_RESULTS = 25; // 意味検索の取得件数
const REINDEX_BATCH_SIZE = 100; // 再索引で取得する件数

//     https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { requireMailbox, type MailboxContext } from "../lib/mailbox";
import { getConfigStub } from "../lib/config";
import { semanticSearch } from "../lib/embeddings";
import { stripHtmlToText } from "../lib/email-helpers";

export const aiApp = new Hono<MailboxContext>();

aiApp.use("/api/inbox/v1/mailboxes/:mailboxId/*", requireMailbox);

/** getModel の処理を実行します。 */ async function getModel(env: Env): Promise<string> {
  try {
    try {
      const m = await getConfigStub(env).getSetting("ai_model");
      if (m && m.trim()) return await m;
    } catch (caught) {
      console.error("[getModel] 失敗", { context: { operation: "getModel" }, err: caught });

      /* ignore */
    }
    return "@cf/moonshotai/kimi-k2.5";
  } catch (err) {
    console.error("[routes.getModel] 失敗", {
      context: { operation: "getModel", parameterCount: 1 },
      err,
    });
    throw err;
  }
}

/** runChat の処理を実行します。 */ async function runChat(
  env: Env,
  system: string,
  user: string,
): Promise<string> {
  try {
    const model = await getModel(env);
    try {
      const result = (await requireBinding(env, "AI").run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      })) as { response?: string; result?: { response?: string } };
      return await (result.response || result.result?.response || "");
    } catch (e) {
      console.error("[runChat] 失敗", { context: { operation: "runChat" }, err: e });

      throw e;
    }
  } catch (err) {
    console.error("[routes.runChat] 失敗", {
      context: { operation: "runChat", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

aiApp.post(
  "/api/inbox/v1/mailboxes/:mailboxId/threads/:threadId/summarize",
  /** aiApp.post /api/inbox/v1/mailboxes/:mailboxId/threads/:threadId/summarize のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const threadId = c.req.param("threadId")!;
      const stub = c.var.mailboxStub;
      const cached = await stub.getThreadSummary(threadId);
      if (cached && !c.req.query("force")) return await c.json(cached);

      const emails = (await stub.getThreadEmails(threadId)) as {
        sender: string;
        date: string;
        body: string;
      }[];
      if (!emails.length) return await c.json({ error: "thread empty" }, HTTP.NOT_FOUND);

      const lang = c.req.query("lang") || "ja";
      const transcript = emails
        .map(
          /** emails.map callback のコールバックを実行します。 */ (e) =>
            `[${e.date}] ${e.sender}\n${stripHtmlToText(e.body || "").slice(0, THREAD_MESSAGE_CHARS)}`,
        )
        .join("\n---\n");

      const system =
        lang === "ja"
          ? "あなたはメールスレッドを要約するアシスタントです。3〜5箇条書きで要点と次のアクションを日本語でまとめてください。"
          : "You summarize an email thread. Reply with 3-5 bullet points (key points + next actions) in English.";

      const summary = await runChat(c.env, system, transcript);
      const model = await getModel(c.env);
      await stub.setThreadSummary(threadId, summary, model);
      return await c.json({ summary, model, generated_at: new Date().toISOString() });
    } catch (err) {
      console.error(
        "[routes.aiApp.post /api/inbox/v1/mailboxes/:mailboxId/threads/:threadId/summarize] 失敗",
        {
          context: {
            operation: "aiApp.post /api/inbox/v1/mailboxes/:mailboxId/threads/:threadId/summarize",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);

const TranslateBody = z.object({ text: z.string().min(1), target: z.string().min(2) });

aiApp.post(
  "/api/inbox/v1/mailboxes/:mailboxId/translate",
  /** aiApp.post /api/inbox/v1/mailboxes/:mailboxId/translate のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const { text, target } = TranslateBody.parse(await c.req.json());
      const system = `You are a precise translator. Translate the user's text to ${target}. Preserve formatting and tone. Return ONLY the translation.`;
      const out = await runChat(c.env, system, text.slice(0, TRANSLATION_CHARS));
      return await c.json({ translation: out, target });
    } catch (err) {
      console.error("[routes.aiApp.post /api/inbox/v1/mailboxes/:mailboxId/translate] 失敗", {
        context: {
          operation: "aiApp.post /api/inbox/v1/mailboxes/:mailboxId/translate",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

const ComposeAssistBody = z.object({
  mode: z.enum(["draft", "rewrite", "shorten"]).default("draft"),
  instruction: z.string().max(MAX_INSTRUCTION_CHARS).optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  lang: z.enum(["ja", "en"]).default("ja"),
});

/** parseComposeAssistOutput の処理を実行します。 */ function parseComposeAssistOutput(
  raw: string,
): { subject?: string; body: string } {
  const trimmed = raw.trim();
  try {
    const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
    const parsed = JSON.parse(jsonText) as { subject?: unknown; body?: unknown };
    if (typeof parsed.body === "string") {
      return {
        subject: typeof parsed.subject === "string" ? parsed.subject : undefined,
        body: parsed.body,
      };
    }
  } catch (caught) {
    console.error("[parseComposeAssistOutput] 失敗", {
      context: { operation: "parseComposeAssistOutput" },
      err: caught,
    });

    /* fall through to raw text */
  }
  return { body: trimmed };
}

aiApp.post(
  "/api/inbox/v1/mailboxes/:mailboxId/compose-assist",
  /** aiApp.post /api/inbox/v1/mailboxes/:mailboxId/compose-assist のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const body = ComposeAssistBody.parse(await c.req.json());
      const system =
        body.lang === "ja"
          ? 'あなたはメール作成を補助する編集者です。自然で簡潔なメール本文を作ります。過度に硬くせず、本文には余計な説明やMarkdownを入れません。必ずJSONだけを返してください。形式: {"subject":"件名","body":"本文"}'
          : 'You help draft and edit email. Write concise, natural email copy. Do not include commentary or markdown. Return JSON only: {"subject":"subject","body":"body"}';
      const modeLabel =
        body.mode === "draft"
          ? "create a new draft"
          : body.mode === "rewrite"
            ? "rewrite and polish the current draft"
            : "shorten the current draft";
      const user = [
        `Mode: ${modeLabel}`,
        `To: ${body.to || "(not set)"}`,
        `Current subject: ${body.subject || "(empty)"}`,
        `Current body:\n${(body.body || "").slice(0, DRAFT_INPUT_CHARS) || "(empty)"}`,
        `User instruction:\n${body.instruction || "(none)"}`,
      ].join("\n\n");
      const out = await runChat(c.env, system, user);
      return await c.json(parseComposeAssistOutput(out));
    } catch (err) {
      console.error("[routes.aiApp.post /api/inbox/v1/mailboxes/:mailboxId/compose-assist] 失敗", {
        context: {
          operation: "aiApp.post /api/inbox/v1/mailboxes/:mailboxId/compose-assist",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

aiApp.get(
  "/api/inbox/v1/mailboxes/:mailboxId/semantic-search",
  /** aiApp.get /api/inbox/v1/mailboxes/:mailboxId/semantic-search のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const query = c.req.query("q") || "";
      const mailboxId = c.req.param("mailboxId")!;
      if (!query.trim()) return await c.json({ matches: [] });
      const matches = await semanticSearch(c.env, mailboxId, query, SEARCH_RESULTS);
      if (matches.length === 0) return await c.json({ matches: [] });
      const stub = c.var.mailboxStub;
      const enriched = await Promise.all(
        matches.map(
          /** matches.map callback のコールバックを実行します。 */ async (m) => {
            try {
              const email = await stub.getEmail(m.id);
              return await (email ? { ...email, score: m.score } : null);
            } catch (err) {
              console.error("[routes.matches.map callback] 失敗", {
                context: { operation: "matches.map callback", parameterCount: 1 },
                err,
              });
              throw err;
            }
          },
        ),
      );
      return await c.json({ matches: enriched.filter(Boolean) });
    } catch (err) {
      console.error("[routes.aiApp.get /api/inbox/v1/mailboxes/:mailboxId/semantic-search] 失敗", {
        context: {
          operation: "aiApp.get /api/inbox/v1/mailboxes/:mailboxId/semantic-search",
          parameterCount: 1,
        },
        err,
      });
      throw err;
    }
  },
);

aiApp.post(
  "/api/inbox/v1/mailboxes/:mailboxId/semantic-search/rebuild",
  /** aiApp.post /api/inbox/v1/mailboxes/:mailboxId/semantic-search/rebuild のコールバックを実行します。 */ async (
    c,
  ) => {
    try {
      const mailboxId = c.req.param("mailboxId")!;
      const stub = c.var.mailboxStub;
      const emails = await stub.getEmails({ limit: REINDEX_BATCH_SIZE, page: 1 });
      const { upsertEmail } = await import("../lib/embeddings");
      let ok = 0;
      for (const e of emails) {
        const full = await stub.getEmail(e.id);
        if (!full) continue;
        const success = await upsertEmail(c.env, mailboxId, {
          id: e.id,
          subject: full.subject || "",
          sender: full.sender || "",
          date: full.date || "",
          body_text: stripHtmlToText(full.body || ""),
        });
        if (success) ok++;
      }
      return await c.json({ rebuilt: ok, total: emails.length });
    } catch (err) {
      console.error(
        "[routes.aiApp.post /api/inbox/v1/mailboxes/:mailboxId/semantic-search/rebuild] 失敗",
        {
          context: {
            operation: "aiApp.post /api/inbox/v1/mailboxes/:mailboxId/semantic-search/rebuild",
            parameterCount: 1,
          },
          err,
        },
      );
      throw err;
    }
  },
);
