import { env as bindings, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../workers/types";

const env = bindings as Env;

describe("folder display order", () => {
  it("places drafts before archive and spam after the other system folders", async () => {
    const stub = env.MAILBOX.getByName(crypto.randomUUID());
    expect((await stub.getFolders()).map(folder => folder.id)).toEqual([
      "inbox", "sent", "draft", "archive", "trash", "spam",
    ]);
  });

  it("sorts custom folders by name after spam regardless of insertion or query order", async () => {
    const stub = env.MAILBOX.getByName(crypto.randomUUID());
    await stub.createFolder("custom-a", "Zulu");
    await stub.createFolder("custom-z", "Alpha");
    await stub.createFolder("custom-m", "Bravo");
    await runInDurableObject(stub, async (instance, state) => {
      // Exercise a different SQLite scan order without changing the migration history.
      state.storage.sql.exec("PRAGMA reverse_unordered_selects = ON");
      const folders = await instance.getFolders();
      expect(folders.map(folder => folder.id)).toEqual([
        "inbox", "sent", "draft", "archive", "trash", "spam",
        "custom-z", "custom-m", "custom-a",
      ]);
      expect(folders.find(folder => folder.id === "custom-z")).toEqual({
        id: "custom-z", name: "Alpha", unreadCount: 0,
      });
    });
  });
});
