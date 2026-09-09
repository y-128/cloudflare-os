// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
import { HTTP } from "../lib/http-status";
import { requireBinding } from "../lib/bindings";
// Copyright (c) 2026 Cloudflare, Inc.
// Modifications Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:

const DEFAULT_TOOL_PAGE_SIZE = 20; // ツールの一覧取得件数
const MAX_AGENT_STEPS = 5; // AIツール実行の最大ステップ数
const THREAD_PREVIEW_CHARS = 500; // AIに渡すスレッド本文の抜粋長

//     https://opensource.org/licenses/Apache-2.0

import { AIChatAgent } from "@cloudflare/ai-chat";
import { streamText, generateText, convertToModelMessages, stepCountIs, type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { EmailFull, EmailMetadata } from "../lib/schemas";
import { verifyDraft, isPromptInjection } from "../lib/ai";
import { getMailboxStub, stripHtmlToText, textToHtml } from "../lib/email-helpers";
import {
  toolListEmails,
  toolGetEmail,
  toolGetThread,
  toolSearchEmails,
  toolDraftReply,
  toolDraftEmail,
  toolMarkEmailRead,
  toolMoveEmail,
  toolDiscardDraft,
} from "../lib/tools";
import {
  Folders,
  FOLDER_TOOL_DESCRIPTION,
  MOVE_FOLDER_TOOL_DESCRIPTION,
} from "../../shared/folders";
import type { Env } from "../types";
import { getConfigStub } from "../lib/config";

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.5";

/** getActiveModel の処理を実行します。 */ async function getActiveModel(
  env: Env,
): Promise<string> {
  try {
    try {
      const m = await getConfigStub(env).getSetting("ai_model");
      if (m && m.trim()) return await m;
    } catch (caught) {
      console.error("[getActiveModel] 失敗", {
        context: { operation: "getActiveModel" },
        err: caught,
      });

      /* fall through */
    }
    return await DEFAULT_MODEL;
  } catch (err) {
    console.error("[agent.getActiveModel] 失敗", {
      context: { operation: "getActiveModel", parameterCount: 1 },
      err,
    });
    throw err;
  }
}

/** isAutoDraftEnabled の処理を実行します。 */ async function isAutoDraftEnabled(
  env: Env,
  mailboxId: string,
): Promise<boolean> {
  try {
    try {
      const stub = getMailboxStub(env, mailboxId);
      const v = await stub.getMailboxSetting("auto_draft_enabled");
      if (v === null || v === undefined) return true; // default ON for backward compat
      return await (v === "1" || v === "true");
    } catch (caught) {
      console.error("[isAutoDraftEnabled] 失敗", {
        context: { operation: "isAutoDraftEnabled" },
        err: caught,
      });

      return true;
    }
  } catch (err) {
    console.error("[agent.isAutoDraftEnabled] 失敗", {
      context: { operation: "isAutoDraftEnabled", parameterCount: 2 },
      err,
    });
    throw err;
  }
}

// AI SDK v6 changed tool() overloads significantly. We define tools as plain
// objects matching the Tool type to avoid overload resolution issues.
function defineTool<Input>(def: {
  description: string;
  parameters: z.ZodType<Input>;
  execute: (input: Input) => Promise<unknown>;
}) {
  return {
    description: def.description,
    inputSchema: def.parameters,
    execute: def.execute,
  };
}

/**
 * Default system prompt used when no custom prompt is configured for a mailbox.
 * Users can override this on a per-mailbox basis via the Settings UI.
 */
const DEFAULT_SYSTEM_PROMPT = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.

## Writing Style
Write like a real person. Short, direct, flowing prose. Get to the point. Plain text only - no HTML tags in your replies.

**Formatting rules:**
- Write in natural paragraphs. NO bullet points, NO numbered lists, NO dashes, NO markdown formatting in email drafts.
- NO bold (**), NO italic (*), NO headers (#), NO horizontal rules (---), NO code blocks. Plain text only.
- Links go inline in the text, not on separate lines.
- Don't structure replies like a template or form letter. Just talk normally.

**Agent Behavior Rules (CRITICAL):**
- NEVER output meta-commentary about what you are doing (e.g. do not say "I am drafting a reply to Alex", "I checked the thread", etc).
- When a new email arrives, your ONLY job is to call the \`draft_reply\` tool.
- DO NOT summarize the email. DO NOT explain your actions.
- Output NOTHING except the tool call. If you must output text, it should ONLY be the literal draft text itself if tools fail.
- Before drafting ANY reply, carefully read the full thread history.
- NEVER repeat information that was already shared in a prior message in the thread.
- Your reply should only contain NEW information or directly respond to what the person just said. Move the conversation forward, don't rehash it.

## Who Are You Replying To?
Use the name the person gives in their email body / signature. That's their name - use it. The "from" address is where you send the reply, but the name in the email is how you greet them.

## CRITICAL: Draft Only - Never Send
You can ONLY draft emails. You do NOT have the ability to send emails directly.

- Use draft_reply to draft replies to existing emails
- Use draft_email to draft new outbound emails
- The operator will review and send drafts from the UI - you cannot send them

**CRITICAL: The draft body must contain ONLY the email text.** Never include agent commentary, status messages, meta-notes, markdown formatting, or anything that isn't part of the actual email in the draft body. No "Draft created.", no "---", no "**bold**", no "Here's the draft:", no separators. The body field is the literal email the recipient will read. Everything else goes in your chat message, not in the draft body.

**Don't paste draft contents into the chat.** The drafts are saved via tools - the operator can see them in the Drafts folder. In your chat message, just briefly say what you drafted (e.g. "Drafted a reply to Tim"). Don't duplicate the full email body in the chat.

## Draft Management
Use discard_draft to delete drafts that the operator rejects or that are no longer needed.`;

/**
 * Fetch the custom system prompt for a mailbox from its R2 settings.
 * Falls back to DEFAULT_SYSTEM_PROMPT if none is configured.
 */
async function getSystemPrompt(
  env: Env,
  mailboxId: string,
  subaddress?: string | null,
): Promise<string> {
  try {
    if (subaddress) {
      try {
        const alias = await getMailboxStub(env, mailboxId).getAlias(subaddress);
        if (
          typeof alias?.system_prompt_override === "string" &&
          alias.system_prompt_override.trim()
        ) {
          return await alias.system_prompt_override;
        }
      } catch (caught) {
        console.error("[getSystemPrompt] 失敗", {
          context: { operation: "getSystemPrompt" },
          err: caught,
        });

        // Fall through to mailbox/default prompt
      }
    }
    try {
      const key = `mailboxes/${mailboxId}.json`;
      const obj = await requireBinding(env, "BUCKET").get(key);
      if (obj) {
        const settings = await obj.json<Record<string, unknown>>();
        if (typeof settings.agentSystemPrompt === "string" && settings.agentSystemPrompt.trim()) {
          return await settings.agentSystemPrompt;
        }
      }
    } catch (caught) {
      console.error("[getSystemPrompt] 失敗", {
        context: { operation: "getSystemPrompt" },
        err: caught,
      });

      // Fall through to default
    }
    return await DEFAULT_SYSTEM_PROMPT;
  } catch (err) {
    console.error("[agent.getSystemPrompt] 失敗", {
      context: { operation: "getSystemPrompt", parameterCount: 3 },
      err,
    });
    throw err;
  }
}

/** createEmailTools の処理を実行します。 */ function createEmailTools(
  env: Env,
  mailboxId: string,
) {
  return {
    list_emails: defineTool({
      description:
        "List emails in a folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id). Use folder='inbox' for received emails, 'sent' for sent emails.",
      parameters: z.object({
        folder: z.string().default(Folders.INBOX).describe(FOLDER_TOOL_DESCRIPTION),
        limit: z
          .number()
          .default(DEFAULT_TOOL_PAGE_SIZE)
          .describe("Maximum number of emails to return"),
        page: z.number().default(1).describe("Page number for pagination"),
      }),
      execute: /** execute のコールバックを実行します。 */ async ({
        folder,
        limit,
        page,
      }): Promise<unknown> => {
        try {
          return await toolListEmails(env, mailboxId, {
            folder: folder ?? Folders.INBOX,
            limit: limit ?? DEFAULT_TOOL_PAGE_SIZE,
            page: page ?? 1,
          });
        } catch (err) {
          console.error("[agent.execute] 失敗", {
            context: { operation: "execute", parameterCount: 1 },
            err,
          });
          throw err;
        }
      },
    }),

    get_email: defineTool({
      description:
        "Get a single email with its full body content and attachments. Use this to read the actual content of an email.",
      parameters: z.object({
        emailId: z.string().describe("The email ID to retrieve"),
      }),
      execute: /** execute のコールバックを実行します。 */ async ({
        emailId,
      }): Promise<unknown> => {
        try {
          return await toolGetEmail(env, mailboxId, emailId);
        } catch (err) {
          console.error("[agent.execute] 失敗", {
            context: { operation: "execute", parameterCount: 1 },
            err,
          });
          throw err;
        }
      },
    }),

    get_thread: defineTool({
      description:
        "Get all emails in a conversation thread. This is essential for understanding the full context of a conversation before drafting a response. Returns all messages sorted chronologically.",
      parameters: z.object({
        threadId: z
          .string()
          .describe(
            "The thread_id to retrieve all messages for. Get this from an email's thread_id field.",
          ),
      }),
      execute: /** execute のコールバックを実行します。 */ async ({
        threadId,
      }): Promise<unknown> => {
        try {
          return await toolGetThread(env, mailboxId, threadId);
        } catch (err) {
          console.error("[agent.execute] 失敗", {
            context: { operation: "execute", parameterCount: 1 },
            err,
          });
          throw err;
        }
      },
    }),

    search_emails: defineTool({
      description: "Search for emails matching a query across subject and body fields.",
      parameters: z.object({
        query: z.string().describe("Search query to match against subject and body"),
        folder: z.string().optional().describe("Optional folder to restrict search to"),
      }),
      execute: /** execute のコールバックを実行します。 */ async ({
        query,
        folder,
      }): Promise<unknown> => {
        try {
          return await toolSearchEmails(env, mailboxId, { query, folder });
        } catch (err) {
          console.error("[agent.execute] 失敗", {
            context: { operation: "execute", parameterCount: 1 },
            err,
          });
          throw err;
        }
      },
    }),

    draft_email: defineTool({
      description:
        "Draft a new email (not a reply) and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review. Use this for composing new outbound emails. Write the body as plain text — no HTML tags.",
      parameters: z.object({
        to: z.string().email().describe("Recipient email address"),
        subject: z.string().describe("Subject line"),
        body: z
          .string()
          .describe("The plain text body of the email. No HTML — just write normally."),
      }),
      execute: /** execute のコールバックを実行します。 */ async ({
        to,
        subject,
        body,
      }): Promise<unknown> => {
        try {
          return await toolDraftEmail(env, mailboxId, {
            to,
            subject,
            body,
            isPlainText: true,
          });
        } catch (err) {
          console.error("[agent.execute] 失敗", {
            context: { operation: "execute", parameterCount: 1 },
            err,
          });
          throw err;
        }
      },
    }),

    draft_reply: defineTool({
      description:
        "Draft a reply to an existing email and save it to the Drafts folder. This does NOT send — it saves a draft for the operator to review and send from the UI. Write the body as plain text — no HTML tags.",
      parameters: z.object({
        originalEmailId: z.string().describe("The ID of the email being replied to"),
        to: z.string().email().describe("Recipient email address"),
        subject: z.string().describe("Subject line (usually 'Re: ...')"),
        body: z
          .string()
          .describe("The plain text body of the reply. No HTML — just write normally."),
      }),
      execute: /** execute のコールバックを実行します。 */ async ({
        originalEmailId,
        to,
        subject,
        body,
      }): Promise<unknown> => {
        try {
          return await toolDraftReply(env, mailboxId, {
            originalEmailId,
            to,
            subject,
            body,
            isPlainText: true,
            runVerifyDraft: true,
          });
        } catch (err) {
          console.error("[agent.execute] 失敗", {
            context: { operation: "execute", parameterCount: 1 },
            err,
          });
          throw err;
        }
      },
    }),

    mark_email_read: defineTool({
      description: "Mark an email as read or unread.",
      parameters: z.object({
        emailId: z.string().describe("The email ID"),
        read: z.boolean().describe("true to mark as read, false for unread"),
      }),
      execute: /** execute のコールバックを実行します。 */ async ({
        emailId,
        read,
      }): Promise<unknown> => {
        try {
          return await toolMarkEmailRead(env, mailboxId, emailId, read);
        } catch (err) {
          console.error("[agent.execute] 失敗", {
            context: { operation: "execute", parameterCount: 1 },
            err,
          });
          throw err;
        }
      },
    }),

    move_email: defineTool({
      description: "Move an email to a different folder (inbox, sent, draft, archive, trash).",
      parameters: z.object({
        emailId: z.string().describe("The email ID"),
        folderId: z.string().describe(MOVE_FOLDER_TOOL_DESCRIPTION),
      }),
      execute: /** execute のコールバックを実行します。 */ async ({
        emailId,
        folderId,
      }): Promise<unknown> => {
        try {
          return await toolMoveEmail(env, mailboxId, emailId, folderId);
        } catch (err) {
          console.error("[agent.execute] 失敗", {
            context: { operation: "execute", parameterCount: 1 },
            err,
          });
          throw err;
        }
      },
    }),

    discard_draft: defineTool({
      description:
        "Delete a draft email. Use this to discard drafts that are no longer needed or were rejected by the operator.",
      parameters: z.object({
        draftId: z.string().describe("The ID of the draft to delete"),
      }),
      execute: /** execute のコールバックを実行します。 */ async ({
        draftId,
      }): Promise<unknown> => {
        try {
          return await toolDiscardDraft(env, mailboxId, draftId);
        } catch (err) {
          console.error("[agent.execute] 失敗", {
            context: { operation: "execute", parameterCount: 1 },
            err,
          });
          throw err;
        }
      },
    }),
  };
}

export class EmailAgent extends AIChatAgent<Env> {
  /** onChatMessage の処理を実行します。 */ async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
  ) {
    try {
      const env = this.env as Env;
      const mailboxId = this.name;
      const workersai = createWorkersAI({ binding: requireBinding(env, "AI") });
      const tools: ToolSet = createEmailTools(env, mailboxId);
      const systemPrompt = await getSystemPrompt(env, mailboxId);
      const modelId = await getActiveModel(env);

      const result = streamText({
        model: workersai(modelId as Parameters<typeof workersai>[0]),
        system: systemPrompt,
        messages: await convertToModelMessages(this.messages),
        tools,
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
        onFinish,
      });

      return await result.toUIMessageStreamResponse();
    } catch (err) {
      console.error("[agent.onChatMessage] 失敗", {
        context: { operation: "onChatMessage", parameterCount: 1 },
        err,
      });
      throw err;
    }
  }

  /**
   * Handle HTTP requests to the agent DO. Intercepts /onNewEmail
   * before passing to the default AIChatAgent handler.
   */
  async onRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/onNewEmail" && request.method === "POST") {
        try {
          const emailData = (await request.json()) as {
            mailboxId: string;
            emailId: string;
            sender: string;
            subject: string;
            threadId: string;
            manual?: boolean;
            subaddress?: string | null;
          };
          // Skip if auto-draft is disabled for this mailbox, UNLESS the
          // caller marked the request as manual (e.g. user-clicked
          // "Generate Draft" button).
          if (!emailData.manual) {
            const enabled = await isAutoDraftEnabled(this.env as Env, emailData.mailboxId);
            if (!enabled) {
              return await new Response(
                JSON.stringify({ status: "skipped", reason: "auto_draft_disabled" }),
                {
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
          }
          const result = await this.handleNewEmail(emailData);
          return await new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          console.error("[onRequest] 失敗", { context: { operation: "onRequest" }, err: e });

          console.error("[onRequest] onNewEmail handler failed:", {
            context: { operation: "onRequest" },
            err: e,
          });
          return await new Response(JSON.stringify({ error: (e as Error).message }), {
            status: HTTP.INTERNAL_SERVER_ERROR,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return await super.onRequest(request);
    } catch (err) {
      console.error("[agent.onRequest] 失敗", {
        context: { operation: "onRequest", parameterCount: 1 },
        err,
      });
      throw err;
    }
  }

  /**
   * Called when a new email arrives. Reads it, loads the thread,
   * drafts a response, and saves it to the Drafts folder.
   */
  async handleNewEmail(emailData: {
    mailboxId: string;
    emailId: string;
    sender: string;
    subject: string;
    threadId: string;
    subaddress?: string | null;
  }) {
    try {
      const env = this.env as Env;
      const workersai = createWorkersAI({ binding: requireBinding(env, "AI") });
      const tools = createEmailTools(env, emailData.mailboxId);
      const systemPrompt = await getSystemPrompt(env, emailData.mailboxId, emailData.subaddress);

      // Pre-read the email and thread so the agent has full context
      // without needing to waste tool calls discovering it
      const stub = getMailboxStub(env, emailData.mailboxId);

      let emailBody = "";
      let threadContext = "";
      try {
        const email = (await stub.getEmail(emailData.emailId)) as EmailFull | null;
        if (email?.body) {
          const isInjection = await isPromptInjection(requireBinding(env, "AI"), email.body);
          if (isInjection) {
            console.warn(
              "[handleNewEmail] Skipping auto-draft due to detected prompt injection:",
              emailData.emailId,
            );

            // Log to agent chat so the user knows why it skipped
            const newMessages = [
              {
                id: crypto.randomUUID(),
                role: "user" as const,
                content: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
                createdAt: new Date(),
                parts: [
                  {
                    type: "text" as const,
                    text: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
                  },
                ],
              },
              {
                id: crypto.randomUUID(),
                role: "assistant" as const,
                content:
                  "⚠️ Blocked auto-draft creation: the email appears to contain prompt injection or malicious instructions.",
                createdAt: new Date(),
                parts: [
                  {
                    type: "text" as const,
                    text: "⚠️ Blocked auto-draft creation: the email appears to contain prompt injection or malicious instructions.",
                  },
                ],
              },
            ];
            await this.persistMessages([...this.messages, ...newMessages]);

            return;
          }

          emailBody = stripHtmlToText(email.body);
        }

        // Load thread for conversation context
        const threadEmails = (await stub.getEmails({
          thread_id: emailData.threadId,
        })) as EmailMetadata[];
        if (threadEmails.length > 1) {
          const fullThread = await Promise.all(
            threadEmails.map(
              /** threadEmails.map callback のコールバックを実行します。 */ async (e) => {
                try {
                  const full = (await stub.getEmail(e.id)) as EmailFull | null;
                  const text = full?.body ? stripHtmlToText(full.body) : "";
                  return await {
                    id: e.id,
                    sender: e.sender,
                    recipient: e.recipient,
                    subject: e.subject,
                    date: e.date,
                    folder_id: e.folder_id,
                    body_text: text,
                  };
                } catch (err) {
                  console.error("[agent.threadEmails.map callback] 失敗", {
                    context: { operation: "threadEmails.map callback", parameterCount: 1 },
                    err,
                  });
                  throw err;
                }
              },
            ),
          );
          fullThread.sort(
            /** fullThread.sort callback のコールバックを実行します。 */ (a, b) =>
              new Date(a.date).getTime() - new Date(b.date).getTime(),
          );
          threadContext = fullThread
            .map(
              /** fullThread.map callback のコールバックを実行します。 */ (e) =>
                `[${e.date}] ${e.sender} → ${e.recipient} (${e.folder_id}): ${e.body_text.substring(0, THREAD_PREVIEW_CHARS)}`,
            )
            .join("\n\n");

          // Scan thread context for prompt injection too -- an attacker
          // could plant an injection in an earlier email in the thread
          // that gets included in the agent's prompt.
          if (threadContext) {
            const threadInjection = await isPromptInjection(
              requireBinding(env, "AI"),
              threadContext,
            );
            if (threadInjection) {
              console.warn(
                "[handleNewEmail] Skipping auto-draft due to prompt injection in thread context:",
                emailData.threadId,
              );
              const newMessages = [
                {
                  id: crypto.randomUUID(),
                  role: "user" as const,
                  content: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
                  createdAt: new Date(),
                  parts: [
                    {
                      type: "text" as const,
                      text: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
                    },
                  ],
                },
                {
                  id: crypto.randomUUID(),
                  role: "assistant" as const,
                  content:
                    "Blocked auto-draft creation: the thread context appears to contain prompt injection or malicious instructions.",
                  createdAt: new Date(),
                  parts: [
                    {
                      type: "text" as const,
                      text: "Blocked auto-draft creation: the thread context appears to contain prompt injection or malicious instructions.",
                    },
                  ],
                },
              ];
              await this.persistMessages([...this.messages, ...newMessages]);
              return;
            }
          }
        }
      } catch (e) {
        console.error("[handleNewEmail] 失敗", {
          context: { operation: "handleNewEmail" },
          err: e,
        });

        console.warn("[handleNewEmail] Pre-read failed, agent will use tools:", {
          context: { operation: "handleNewEmail" },
          err: e,
        });
      }

      let autoPrompt = `A new email just arrived. Draft an appropriate response using draft_reply.

Email details:
- Mailbox: ${emailData.mailboxId}
- Email ID: ${emailData.emailId}
- From: ${emailData.sender}
- Subject: ${emailData.subject}
- Thread ID: ${emailData.threadId}

Email body:
${emailBody || "(could not pre-read — use get_email to read it)"}`;

      if (threadContext) {
        autoPrompt += `

Full thread history (${emailData.threadId}):
${threadContext}`;
      } else {
        autoPrompt += `

This is the first message in the thread (no prior conversation).`;
      }

      autoPrompt += `

Based on the email content and thread context above, draft a reply using draft_reply. If you need more context, use get_thread with thread ID "${emailData.threadId}".`;

      // Fresh context for auto-draft -- don't include prior chat history
      // to avoid confusing the model with old messages and tool calls
      const messages = [
        {
          role: "user" as const,
          content: autoPrompt,
          parts: [{ type: "text" as const, text: autoPrompt }],
          createdAt: new Date(),
        },
      ];

      try {
        const modelId = await getActiveModel(env);
        const result = await generateText({
          model: workersai(modelId as Parameters<typeof workersai>[0]),
          system: systemPrompt,
          messages: await convertToModelMessages(messages),
          tools,
          stopWhen: stepCountIs(MAX_AGENT_STEPS),
        });

        // Check if draft_reply was called (saves to Drafts as side effect).
        // If NOT, save the agent's text response as a draft directly.
        const draftToolCalled = result.steps.some(
          /** result.steps.some callback のコールバックを実行します。 */ (step) =>
            step.toolCalls.some(
              /** step.toolCalls.some callback のコールバックを実行します。 */ (tc) =>
                tc.toolName === "draft_reply" || tc.toolName === "draft_email",
            ),
        );

        if (!draftToolCalled && result.text.trim()) {
          // Model generated a draft inline as text -- verify with AI
          const sanitizedText = await verifyDraft(requireBinding(env, "AI"), result.text.trim());
          if (!sanitizedText) {
            // Inline text was entirely agent commentary, skip
          } else {
            const draftId = crypto.randomUUID();
            const draftStub = getMailboxStub(env, emailData.mailboxId);
            const reSubject = emailData.subject.startsWith("Re:")
              ? emailData.subject
              : `Re: ${emailData.subject}`;
            await draftStub.createEmail(
              Folders.DRAFT,
              {
                id: draftId,
                subject: reSubject,
                sender: emailData.mailboxId.toLowerCase(),
                recipient: emailData.sender.toLowerCase(),
                date: new Date().toISOString(),
                // verifyDraft may return plain text or HTML depending on its
                // code path. Only wrap in textToHtml if it's plain text.
                body: /<[a-z][\s\S]*>/i.test(sanitizedText)
                  ? sanitizedText
                  : textToHtml(sanitizedText),
                in_reply_to: emailData.emailId,
                email_references: null,
                thread_id: emailData.threadId,
              },
              [],
            );
            // Inline text saved as draft
          }
        }

        // Persist the conversation into the agent's chat history
        // If it called the tool, we just log a simple success message so the chat isn't cluttered
        // with conversational slop.
        const assistantText = draftToolCalled
          ? `Created draft reply to ${emailData.sender}.`
          : result.text;

        const newMessages = [
          {
            id: crypto.randomUUID(),
            role: "user" as const,
            content: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
            createdAt: new Date(),
            parts: [
              {
                type: "text" as const,
                text: `[Auto-triggered] New email from ${emailData.sender}: "${emailData.subject}"`,
              },
            ],
          },
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: assistantText,
            createdAt: new Date(),
            parts: [
              {
                type: "text" as const,
                text: assistantText,
              },
            ],
          },
        ];

        await this.persistMessages([...this.messages, ...newMessages]);

        return await { status: "draft_generated", text: result.text };
      } catch (e) {
        console.error("[handleNewEmail] 失敗", {
          context: { operation: "handleNewEmail" },
          err: e,
        });

        console.error("[handleNewEmail] Auto-draft failed:", {
          context: { operation: "handleNewEmail" },
          err: e,
        });
        return await { status: "error", error: (e as Error).message };
      }
    } catch (err) {
      console.error("[agent.handleNewEmail] 失敗", {
        context: { operation: "handleNewEmail", parameterCount: 1 },
        err,
      });
      throw err;
    }
  }
}
