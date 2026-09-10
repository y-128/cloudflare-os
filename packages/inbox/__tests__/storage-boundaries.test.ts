import { env as bindings, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../workers/types";
import { Folders } from "../shared/folders";
import { classify, tokenize } from "../workers/lib/bayes";
import { BodyStore } from "../workers/durableObject/body-store";
import {
  BODY_CLEANUP_RETRY_MS,
  BODY_SEARCH_CHUNK_CHARACTERS,
  INLINE_BODY_MAX_BYTES,
} from "../workers/durableObject/storage-limits";

import { translate } from "../../i18n/src/core";
const t = translate.bind(null, "ja");

const env = bindings as Env;
const LARGE_BODY_BYTES = 12 * 1024 * 1024; // Reproduce the reported SQLITE_TOOBIG payload.

/** Restore fault injection after each test. */
afterEach(() => vi.restoreAllMocks());

/** Create an isolated mailbox backed by real Workers SQLite. */
function mailbox() {
  return env.MAILBOX.getByName(crypto.randomUUID());
}

/** Supply complete email data without calling external APIs. */
function email(body = "Stored body") {
  const id = crypto.randomUUID();
  return {
    id,
    subject: "Boundary",
    sender: "sender@example.net",
    recipient: "reader@example.com",
    date: "2026-09-10T00:00:00.000Z",
    body,
    thread_id: id,
    read: true,
  };
}

/** Build all seven attachment columns used by production inserts. */
function attachments(emailId: string, count: number) {
  return Array.from(
    { length: count },
    /** Generate unique metadata. */ (_, i) => ({
      id: crypto.randomUUID(),
      email_id: emailId,
      filename: `note-${i}.txt`,
      mimetype: "text/plain",
      size: 1,
      content_id: null,
      disposition: "attachment",
    }),
  );
}

describe("SQLite storage boundaries", () => {
  it.each([100, 101, 200])("looks up %i distinct tokens with an unchanged score", async (count) => {
    const stub = mailbox();
    const tokens = tokenize(
      Array.from({ length: count }, /** Generate distinct words. */ (_, i) => `word${i}`).join(" "),
    );
    expect(tokens).toHaveLength(count);
    await stub.bayesTrain(tokens, "spam");
    await stub.bayesTrain(tokens.slice(0, 50), "ham");
    const expected = Object.fromEntries(
      tokens.map(
        /** Reconstruct training counts independently of lookup. */
        (token, i) => [token, { spam_count: 1, ham_count: i < 50 ? 1 : 0 }],
      ),
    );
    const result = await stub.bayesLookup(tokens);
    expect(result).toEqual({ counts: expected, totals: { spam: 1, ham: 1 } });
    expect(classify(tokens, result.counts, result.totals)).toBe(
      classify(tokens, expected, { spam: 1, ham: 1 }),
    );
    expect(await stub.bayesLookup([])).toEqual({ counts: {}, totals: { spam: 0, ham: 0 } });
  });

  it.each([14, 15])("stores the body and all %i attachments", async (count) => {
    const stub = mailbox();
    const data = email();
    const rows = attachments(data.id, count);
    await stub.createEmail(Folders.INBOX, data, rows);
    const stored = await stub.getEmail(data.id);
    expect(stored?.body).toBe(data.body);
    expect(stored?.attachments).toEqual(expect.arrayContaining(rows));
    expect(stored?.attachments).toHaveLength(count);
  });

  it("rolls back the body and first batch if the second attachment batch fails", async () => {
    const stub = mailbox();
    const data = email();
    const rows = attachments(data.id, 15);
    rows[14].id = rows[0].id;
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.createEmail(Folders.INBOX, data, rows)).rejects.toThrow();
    });
    expect(await stub.getEmail(data.id)).toBeNull();
    expect(await stub.getAttachment(rows[0].id)).toBeNull();
  });

  it.each([100, 101])(
    "loads %i thread messages without another thread's attachments",
    async (count) => {
      const stub = mailbox();
      const threadId = crypto.randomUUID();
      for (let i = 0; i < count; i++) {
        const data = { ...email(), thread_id: threadId, date: new Date(i * 1000).toISOString() };
        await stub.createEmail(Folders.INBOX, data, attachments(data.id, 1));
      }
      const other = email();
      const otherRows = attachments(other.id, 1);
      await stub.createEmail(Folders.INBOX, other, otherRows);
      const thread = await stub.getThreadEmails(threadId);
      expect(thread).toHaveLength(count);
      for (const row of thread) {
        expect(row.body).toBe("Stored body");
        expect(row.attachments).toHaveLength(1);
        expect(row.attachments[0].email_id).toBe(row.id);
        expect(row.attachments[0].id).not.toBe(otherRows[0].id);
      }
      const dates = thread.map(/** Extract chronological ordering. */ (row) => row.date);
      expect(dates).toEqual(dates.toSorted());
    },
  );

  it.each(["query", "from", "to", "subject"] as const)(
    "validates %s at 50 and 51 pattern bytes in search and count",
    async (field) => {
      const stub = mailbox();
      const ascii = "a".repeat(48);
      const japanese = "日".repeat(16);
      const text = `${ascii} ${japanese}`;
      await stub.createEmail(
        Folders.INBOX,
        {
          ...email(text),
          subject: text,
          sender: text,
          recipient: text,
        },
        [],
      );
      for (const term of [ascii, japanese]) {
        const filter = { query: "", [field]: term };
        expect(await stub.searchEmails(filter)).toHaveLength(1);
        expect(await stub.countSearchResults(filter)).toBe(1);
      }
      for (const term of [ascii + "a", japanese + "a", japanese + "日"]) {
        const filter = { query: "", [field]: term };
        await runInDurableObject(stub, async (instance) => {
          await expect(instance.searchEmails(filter)).rejects.toThrow(t("inbox.search.pattern_too_long"));
          await expect(instance.countSearchResults(filter)).rejects.toThrow(t("inbox.search.pattern_too_long"));
        });
      }
    },
  );

  it("computes draft/reply flags by IDs even after folders are renamed", async () => {
    const stub = mailbox();
    const received = email();
    await stub.createEmail(Folders.INBOX, received, []);
    await stub.updateFolder(Folders.DRAFT, "Renamed drafts");
    await stub.updateFolder(Folders.SENT, "Renamed sent");
    expect((await stub.getThreadedEmails({ folder: Folders.INBOX }))[0]).toMatchObject({
      needs_reply: true,
      has_draft: false,
    });
    const draft = { ...email(), thread_id: received.id, date: "2026-09-10T01:00:00.000Z" };
    await stub.createEmail(Folders.DRAFT, draft, []);
    expect((await stub.getThreadedEmails({ folder: Folders.INBOX }))[0]).toMatchObject({
      needs_reply: false,
      has_draft: true,
    });
    await stub.deleteEmail(draft.id);
    const sent = { ...email(), thread_id: received.id, date: "2026-09-10T02:00:00.000Z" };
    await stub.createEmail(Folders.SENT, sent, []);
    expect((await stub.getThreadedEmails({ folder: Folders.INBOX }))[0]).toMatchObject({
      needs_reply: false,
      has_draft: false,
    });
  });

  it("serializes logged errors with the message instead of an empty object", async () => {
    await runInDurableObject(mailbox(), async (instance) => {
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(/** Suppress expected error output. */ () => {});
      await expect(instance.createEmail("missing-folder", email(), [])).rejects.toThrow();
      const fields = log.mock.calls.find(
        /** Locate the storage error. */ (call) => call[0] === "[durableObject.createEmail] failed",
      )?.[1];
      expect(fields).toMatchObject({ err: expect.stringContaining("not found") });
      expect(JSON.stringify(fields)).not.toContain('"err":{}');
    });
  });
});

describe("large email bodies", () => {
  it.each([INLINE_BODY_MAX_BYTES, INLINE_BODY_MAX_BYTES + 1])(
    "round-trips %i bytes at the inline threshold",
    async (size) => {
      await runInDurableObject(mailbox(), async (instance, state) => {
        const data = email("x".repeat(size));
        await instance.createEmail(Folders.INBOX, data, []);
        expect((await instance.getEmail(data.id))?.body).toBe(data.body);
        expect(state.storage.sql.exec("SELECT * FROM email_body_objects").toArray()).toHaveLength(
          size > INLINE_BODY_MAX_BYTES ? 1 : 0,
        );
      });
    },
  );

  it("keeps 12 MiB, searches the end and chunk boundary, then removes R2 and chunks", async () => {
    await runInDurableObject(mailbox(), async (instance, state) => {
      const boundaryWord = "boundary-needle";
      const prefix = "x".repeat(BODY_SEARCH_CHUNK_CHARACTERS - 5);
      const body =
        prefix +
        boundaryWord +
        "x".repeat(LARGE_BODY_BYTES - prefix.length - boundaryWord.length) +
        "末尾確認";
      expect(() => state.storage.sql.exec("SELECT length(?)", body)).toThrow();
      const data = email(body);
      await instance.createEmail(Folders.INBOX, data, []);
      expect((await instance.getEmail(data.id))?.body).toBe(body);
      expect((await instance.getThreadEmails(data.id))[0].body).toBe(body);
      const key = String(
        state.storage.sql.exec("SELECT object_key FROM email_body_objects").one().object_key,
      );
      expect(await (await env.BUCKET.get(key))?.text()).toBe(body);
      expect(state.storage.sql.exec("SELECT body FROM emails").one().body).toBe(body.slice(0, 300));
      for (const query of [boundaryWord, "末尾確認"]) {
        expect(await instance.searchEmails({ query })).toHaveLength(1);
        expect(await instance.countSearchResults({ query })).toBe(1);
      }
      await instance.deleteEmail(data.id);
      expect(await env.BUCKET.get(key)).toBeNull();
      expect(state.storage.sql.exec("SELECT * FROM email_body_objects").toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT * FROM email_body_chunks").toArray()).toHaveLength(0);
    });
  });

  it("round-trips a 12 MiB body through real Durable Object RPC", async () => {
    const stub = mailbox();
    const data = email("x".repeat(LARGE_BODY_BYTES));
    await stub.createEmail(Folders.INBOX, data, []);
    expect((await stub.getEmail(data.id))?.body).toBe(data.body);
  });

  it("measures UTF-8 bytes and preserves emoji and literal search symbols", async () => {
    await runInDurableObject(mailbox(), async (instance) => {
      const data = email("😀".repeat(INLINE_BODY_MAX_BYTES / 4 + 1) + "100%_complete");
      await instance.createEmail(Folders.INBOX, data, []);
      expect((await instance.getEmail(data.id))?.body).toBe(data.body);
      expect(await instance.countSearchResults({ query: "100%_complete" })).toBe(1);
      expect(await instance.countSearchResults({ query: "😀😀" })).toBe(1);
    });
  });

  it("cleans rolled-back uploads without deleting existing bodies on duplicate IDs", async () => {
    await runInDurableObject(mailbox(), async (instance, state) => {
      const data = email("x".repeat(INLINE_BODY_MAX_BYTES + 1));
      await instance.createEmail(Folders.INBOX, data, []);
      await expect(
        instance.createEmail(Folders.INBOX, { ...data, body: data.body + "duplicate" }, []),
      ).rejects.toThrow();
      expect(state.storage.sql.exec("SELECT * FROM email_body_objects").toArray()).toHaveLength(1);
      expect((await instance.getEmail(data.id))?.body).toBe(data.body);
      const failed = { ...data, id: crypto.randomUUID() };
      const rows = attachments(failed.id, 15);
      rows[14].id = rows[0].id;
      await expect(instance.createEmail(Folders.INBOX, failed, rows)).rejects.toThrow();
      expect(await instance.getEmail(failed.id)).toBeNull();
      expect(state.storage.sql.exec("SELECT * FROM email_body_objects").toArray()).toHaveLength(1);
    });
  });

  it("reports missing R2 content instead of silently returning a preview", async () => {
    await runInDurableObject(mailbox(), async (instance, state) => {
      const data = email("x".repeat(INLINE_BODY_MAX_BYTES + 1));
      await instance.createEmail(Folders.INBOX, data, []);
      const key = String(
        state.storage.sql.exec("SELECT object_key FROM email_body_objects").one().object_key,
      );
      await env.BUCKET.delete(key);
      await expect(instance.getEmail(data.id)).rejects.toThrow("メール本文が見つかりません");
      await expect(instance.getThreadEmails(data.id)).rejects.toThrow("メール本文が見つかりません");
    });
  });

  it("retains failed R2 cleanup for retry after reconstructing the store", async () => {
    await runInDurableObject(mailbox(), async (_instance, state) => {
      const bucket = {
        put: vi.fn().mockRejectedValue(new Error("R2 write failure")),
        delete: vi.fn().mockRejectedValue(new Error("R2 delete failure")),
      };
      // Fault injection implements only the R2 methods exercised by this test.
      const testEnv = { ...env, BUCKET: bucket as unknown as R2Bucket };
      const store = new BodyStore(state.storage, testEnv);
      const body = "x".repeat(INLINE_BODY_MAX_BYTES + 1);
      const key = store.reserve(body)!;
      await expect(store.write(key, body)).rejects.toThrow("R2 write failure");
      await store.discard(key);
      expect(state.storage.sql.exec("SELECT * FROM email_body_objects").toArray()).toHaveLength(1);
      expect(store.nextCleanup()).toBeGreaterThanOrEqual(Date.now() + BODY_CLEANUP_RETRY_MS);
      state.storage.sql.exec("UPDATE email_body_objects SET cleanup_at = 0");
      bucket.delete.mockResolvedValue(undefined);
      await new BodyStore(state.storage, testEnv).cleanup();
      expect(state.storage.sql.exec("SELECT * FROM email_body_objects").toArray()).toHaveLength(0);
    });
  });

  it("protects active uploads and committed bodies during cleanup", async () => {
    await runInDurableObject(mailbox(), async (instance, state) => {
      const data = email("x".repeat(INLINE_BODY_MAX_BYTES + 1));
      await instance.createEmail(Folders.INBOX, data, []);
      const store = new BodyStore(state.storage, env);
      const pendingKey = store.reserve(data.body)!;
      await store.write(pendingKey, data.body);
      state.storage.sql.exec("UPDATE email_body_objects SET cleanup_at = 0");
      await store.cleanup();
      expect(await env.BUCKET.head(pendingKey)).not.toBeNull();
      expect((await instance.getEmail(data.id))?.body).toBe(data.body);
      store.release(pendingKey);
      await new BodyStore(state.storage, env).cleanup();
      expect(await env.BUCKET.head(pendingKey)).toBeNull();
      expect((await instance.getEmail(data.id))?.body).toBe(data.body);
    });
  });

  it("runs interrupted-upload cleanup through the existing DO alarm", async () => {
    await runInDurableObject(mailbox(), async (instance, state) => {
      const store = new BodyStore(state.storage, env);
      const body = "x".repeat(INLINE_BODY_MAX_BYTES + 1);
      const key = store.reserve(body)!;
      await store.write(key, body);
      store.release(key);
      state.storage.sql.exec("UPDATE email_body_objects SET cleanup_at = 0");
      await instance.alarm();
      expect(await env.BUCKET.head(key)).toBeNull();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("cleans folder-deleted bodies while retaining the next scheduled-send alarm", async () => {
    await runInDurableObject(mailbox(), async (instance, state) => {
      await instance.createFolder("custom", "Custom");
      const data = email("x".repeat(INLINE_BODY_MAX_BYTES + 1));
      await instance.createEmail("custom", data, []);
      const key = String(
        state.storage.sql.exec("SELECT object_key FROM email_body_objects").one().object_key,
      );
      const draft = email();
      await instance.createEmail(Folders.DRAFT, draft, []);
      const sendAt = Date.now() + 60_000;
      await instance.createScheduledSend(draft.id, new Date(sendAt).toISOString());
      await instance.deleteFolder("custom");
      expect(await env.BUCKET.head(key)).toBeNull();
      expect(await state.storage.getAlarm()).toBe(sendAt);
    });
  });
});
