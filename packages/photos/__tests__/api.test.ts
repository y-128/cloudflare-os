import { beforeEach, describe, expect, it } from "vitest";
import type {
  AlbumView, LibraryUsage, Page, PhotoDetail, PhotoSummary, PhotographerSuggestion,
  PhotographerView, TagView,
} from "../shared/api-types";
import type { PhotoId } from "../shared/ids";
import type { SearchQuery } from "../shared/search-query";
import { applyMigrations, SCHEMA_VERSION } from "../workers/db/migrate";
import { recordUsage } from "../workers/db/usage";
import { ACTOR, addPhoto, call, callJson, env, fakeWorkshop, resetDb } from "./helpers";

beforeEach(resetDb);

/** Every id a search returns, following cursors to the end. */
async function searchIds(query: SearchQuery, limit = 2): Promise<PhotoId[]> {
  const ids: PhotoId[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<PhotoSummary> = await callJson("POST", "/photos/search", { query, cursor, limit });
    ids.push(...page.items.map((p) => p.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

describe("access", () => {
  it("admits administrators the Workshop vouches for and denies everyone else", async () => {
    expect((await call("GET", "/tags")).status).toBe(200);
    expect((await call("GET", "/tags", { headers: { Authorization: "Bearer someone" } })).status).toBe(403);
    expect((await call("GET", "/tags", { headers: { "X-Photos-Request": "" } })).status).toBe(403);
  });

  it("forwards only credentials and cross-site context to the Workshop", async () => {
    const workshop = fakeWorkshop();
    await call("GET", "/tags", {
      headers: { Cookie: "session=1", "X-Other": "x", Origin: "https://cfos.example" },
      env: { WORKSHOP_AUTH: workshop.fetcher },
    });
    const [forwarded] = workshop.seen;
    expect(new URL(forwarded.url).pathname).toBe("/api/photos-auth");
    expect([...forwarded.headers.keys()].toSorted())
      .toEqual(["authorization", "origin", "x-photos-request"]);
  });

  it("fails closed when the Workshop is unreachable", async () => {
    const broken = { fetch: async () => { throw new Error("down"); } } as unknown as Fetcher;
    expect((await call("GET", "/tags", { env: { WORKSHOP_AUTH: broken } })).status).toBe(403);
  });

  it("refuses to run without a well-formed credential key", async () => {
    for (const key of [undefined, "short", "not base64!"]) {
      const response = await call("GET", "/tags", { env: { PHOTOS_CREDENTIAL_KEY: key } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "credential_key_missing" });
    }
  });

  it("marks every response uncacheable", async () => {
    const response = await call("GET", "/tags");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await call("GET", "/nope")).status).toBe(404);
  });
});

describe("schema", () => {
  it("applies migrations once and is idempotent", async () => {
    expect(await applyMigrations(env.PHOTOS_DB)).toBe(SCHEMA_VERSION);
    expect(await applyMigrations(env.PHOTOS_DB)).toBe(SCHEMA_VERSION);
    const { results } = await env.PHOTOS_DB.prepare("SELECT version FROM schema_migrations").all();
    expect(results).toHaveLength(SCHEMA_VERSION);
  });
});

describe("search", () => {
  it("pages through every photo in capture order without gaps or repeats", async () => {
    const ids = [await addPhoto(), await addPhoto(), await addPhoto(), await addPhoto(), await addPhoto()];
    expect(await searchIds({})).toEqual(ids.toReversed());
    expect(await searchIds({ sort: "taken_asc" }, 3)).toEqual(ids);
  });

  it("keeps ties on capture time stable across pages", async () => {
    const ids = await Promise.all([1, 2, 3].map(() => addPhoto({ takenAt: 42 })));
    expect((await searchIds({ sort: "taken_asc" }, 1)).toSorted()).toEqual(ids.toSorted());
  });

  it("filters by EXIF, numeric comparisons, RAW and favorites", async () => {
    const a7 = await addPhoto({ exif: { model: "ILCE-7M4", iso: 100, lensModel: "FE 35mm F1.4 GM" }, raw: true });
    const z9 = await addPhoto({ exif: { model: "Z 9", iso: 3200 } });
    await addPhoto();
    await callJson("PATCH", `/photos/${z9}`, { favorite: true });

    expect(await searchIds({ cameraModels: ["ILCE-7M4"] })).toEqual([a7]);
    expect(await searchIds({ numeric: [{ field: "iso", op: "lte", value: 800 }] })).toEqual([a7]);
    expect(await searchIds({ lensModels: ["FE 35mm F1.4 GM"], hasRaw: true })).toEqual([a7]);
    expect(await searchIds({ favorite: true })).toEqual([z9]);
  });

  it("treats search text literally, including LIKE wildcards", async () => {
    const percent = await addPhoto({ filename: "100%_crop.jpg" });
    await addPhoto({ filename: "100x crop.jpg" });
    expect(await searchIds({ text: "100%_" })).toEqual([percent]);
  });

  it("matches a tag's descendants, with all/any semantics", async () => {
    const event = await callJson<TagView>("POST", "/tags", { name: "Event" });
    const kemocon = await callJson<TagView>("POST", "/tags", { name: "Kemocon", parentId: event.id });
    const outdoor = await callJson<TagView>("POST", "/tags", { name: "Outdoor" });
    const inside = await addPhoto({ tagIds: [kemocon.id] });
    const both = await addPhoto({ tagIds: [kemocon.id, outdoor.id] });
    await addPhoto({ tagIds: [outdoor.id] });

    expect((await searchIds({ tagIds: [event.id] })).toSorted()).toEqual([inside, both].toSorted());
    expect(await searchIds({ tagIds: [event.id, outdoor.id], tagMatch: "all" })).toEqual([both]);
  });

  it("moves photos to the trash and back", async () => {
    const id = await addPhoto();
    expect((await call("DELETE", `/photos/${id}`)).status).toBe(204);
    expect((await callJson<PhotoDetail>("GET", `/photos/${id}`)).deletedAt).toBeGreaterThan(0);
    expect(await searchIds({})).toEqual([]);
    expect(await searchIds({ trashed: true })).toEqual([id]);
    await call("POST", `/photos/${id}/restore`);
    expect(await searchIds({})).toEqual([id]);
  });

  it("rejects malformed queries and cursors", async () => {
    expect((await call("POST", "/photos/search", { body: { query: { sort: "random" } } })).status).toBe(400);
    expect((await call("POST", "/photos/search", { body: { query: { numeric: [{ field: "id", op: "eq", value: 1 }] } } })).status).toBe(400);
    expect((await call("POST", "/photos/search", { body: { query: {}, cursor: "garbage" } })).status).toBe(400);
  });
});

describe("inspector", () => {
  it("returns the photo with its EXIF, files and edit history", async () => {
    const id = await addPhoto({ exif: { model: "ILCE-7M4", fNumber: 2.8, gps: { lat: 35.6, lon: 139.7 } } });
    const detail = await callJson<PhotoDetail>("GET", `/photos/${id}`);
    expect(detail.exif).toMatchObject({ model: "ILCE-7M4", fNumber: 2.8, gps: { lat: 35.6, lon: 139.7 } });
    expect(detail.assets).toHaveLength(1);
    expect(detail.assets[0]).toMatchObject({ role: "original", isPrimary: true, connection: { name: "Test R2" } });
    expect(detail.createdBy).toBe(ACTOR);
    expect(detail.originalAvailable).toBe(true);
  });

  it("applies edits and records a manual capture time", async () => {
    const id = await addPhoto();
    const detail = await callJson<PhotoDetail>("PATCH", `/photos/${id}`, {
      title: "Sunset", visibility: "unlisted", downloadAllowed: true, rating: 4, takenAt: 5,
    });
    expect(detail).toMatchObject({
      title: "Sunset", visibility: "unlisted", downloadAllowed: true, rating: 4, takenAt: 5,
      takenAtSource: "manual",
    });
  });

  it("rejects unknown fields and ids", async () => {
    const id = await addPhoto();
    expect((await call("PATCH", `/photos/${id}`, { body: { owner: "me" } })).status).toBe(400);
    expect((await call("GET", "/photos/pho_01J00000000000000000000000")).status).toBe(404);
    expect((await call("GET", "/photos/not-an-id")).status).toBe(400);
  });

  it("reports originals on offline storage as unavailable", async () => {
    const id = await addPhoto();
    await env.PHOTOS_DB.prepare("UPDATE storage_connections SET status = 'offline'").run();
    expect((await callJson<PhotoDetail>("GET", `/photos/${id}`)).originalAvailable).toBe(false);
  });
});

describe("bulk edit", () => {
  it("changes fields, tags and albums of every selected photo at once", async () => {
    const tag = await callJson<TagView>("POST", "/tags", { name: "Event" });
    const album = await callJson<AlbumView>("POST", "/albums", { title: "2026" });
    const ids = [await addPhoto(), await addPhoto()];
    const untouched = await addPhoto();
    const response = await call("POST", "/photos/bulk", {
      body: { photoIds: ids, set: { visibility: "public" }, addTagIds: [tag.id], addToAlbumIds: [album.id] },
    });
    expect(response.status).toBe(204);
    expect((await searchIds({ visibility: ["public"] })).toSorted()).toEqual(ids.toSorted());
    expect((await searchIds({ tagIds: [tag.id] })).toSorted()).toEqual(ids.toSorted());
    expect((await callJson<AlbumView>("GET", `/albums/${album.id}`)).photoCount).toBe(2);
    expect(await searchIds({ visibility: ["private"] })).toEqual([untouched]);

    await call("POST", "/photos/bulk", { body: { photoIds: ids, removeTagIds: [tag.id], removeFromAlbumIds: [album.id] } });
    expect(await searchIds({ tagIds: [tag.id] })).toEqual([]);
    expect((await callJson<AlbumView>("GET", `/albums/${album.id}`)).photoCount).toBe(0);
  });

  it("caps the selection size", async () => {
    const photoIds = Array.from({ length: 501 }, () => "pho_01J00000000000000000000000");
    expect((await call("POST", "/photos/bulk", { body: { photoIds } })).status).toBe(400);
  });
});

describe("tags", () => {
  it("renames and moves a subtree, rewriting descendant paths", async () => {
    const event = await callJson<TagView>("POST", "/tags", { name: "Event" });
    const child = await callJson<TagView>("POST", "/tags", { name: "A", parentId: event.id });
    const people = await callJson<TagView>("POST", "/tags", { name: "People" });

    await callJson("PATCH", `/tags/${event.id}`, { name: "Events", parentId: people.id });
    const paths = (await callJson<TagView[]>("GET", "/tags")).map((t) => t.path);
    expect(paths).toEqual(["/People/", "/People/Events/", "/People/Events/A/"]);
    expect((await call("PATCH", `/tags/${event.id}`, { body: { parentId: child.id } })).status).toBe(409);
  });

  it("rejects duplicate siblings and separators", async () => {
    await callJson("POST", "/tags", { name: "Event" });
    expect((await call("POST", "/tags", { body: { name: "Event" } })).status).toBe(409);
    expect((await call("POST", "/tags", { body: { name: "a/b" } })).status).toBe(400);
  });

  it("deletes a subtree and its photo associations", async () => {
    const event = await callJson<TagView>("POST", "/tags", { name: "Event" });
    const child = await callJson<TagView>("POST", "/tags", { name: "A", parentId: event.id });
    await addPhoto({ tagIds: [child.id] });
    await call("DELETE", `/tags/${event.id}`);
    expect(await callJson<TagView[]>("GET", "/tags")).toEqual([]);
    const { results } = await env.PHOTOS_DB.prepare("SELECT * FROM photo_tags").all();
    expect(results).toEqual([]);
  });
});

describe("albums", () => {
  it("appends in capture order and reorders without renumbering", async () => {
    const album = await callJson<AlbumView>("POST", "/albums", { title: "Trip" });
    const [a, b, c] = [await addPhoto(), await addPhoto(), await addPhoto()];
    await call("POST", `/albums/${album.id}/photos`, { body: { photoIds: [c, a, b] } });
    const order = async () => (await env.PHOTOS_DB.prepare(
      "SELECT photo_id FROM album_photos WHERE album_id = ? ORDER BY position",
    ).bind(album.id).all<{ photo_id: string }>()).results.map((r) => r.photo_id);
    expect(await order()).toEqual([a, b, c]);

    await call("PATCH", `/albums/${album.id}/photos/order`, { body: { photoId: c, afterPhotoId: a } });
    expect(await order()).toEqual([a, c, b]);
    await call("PATCH", `/albums/${album.id}/photos/order`, { body: { photoId: b, afterPhotoId: null } });
    expect(await order()).toEqual([b, a, c]);
  });

  it("counts only photos outside the trash and keeps photos when deleted", async () => {
    const album = await callJson<AlbumView>("POST", "/albums", { title: "Trip", downloadOverride: false });
    expect(album.downloadOverride).toBe(false);
    const [a, b] = [await addPhoto(), await addPhoto()];
    await call("POST", `/albums/${album.id}/photos`, { body: { photoIds: [a, b] } });
    await call("DELETE", `/photos/${a}`);
    expect((await callJson<AlbumView>("GET", `/albums/${album.id}`)).photoCount).toBe(1);
    await call("DELETE", `/albums/${album.id}`);
    expect(await searchIds({ trashed: true })).toEqual([a]);
    expect(await searchIds({})).toEqual([b]);
  });
});

describe("photographers", () => {
  it("assigns photographers from EXIF Artist aliases, ignoring width and case", async () => {
    const takuya = await callJson<PhotographerView>("POST", "/photographers", { name: "Takuya Yoshida" });
    const old = await addPhoto({ exif: { artist: "Ｔ. Yoshida" } });
    await addPhoto({ exif: { artist: "Someone Else" } });

    const suggestions = await callJson<PhotographerSuggestion[]>("GET", "/photographers/suggestions");
    expect(suggestions.map((s) => s.artist).toSorted()).toEqual(["Someone Else", "Ｔ. Yoshida"]);

    const { assigned } = await callJson<{ assigned: number }>("POST", `/photographers/${takuya.id}/aliases`,
      { artist: "t. yoshida" });
    expect(assigned).toBe(1);
    expect((await callJson<PhotoDetail>("GET", `/photos/${old}`)).photographer?.id).toBe(takuya.id);

    const later = await addPhoto({ exif: { artist: "T. YOSHIDA" } });
    expect(await searchIds({ photographerIds: [takuya.id] })).toEqual([later, old]);
  });

  it("suggests without assigning when the alias is not applied", async () => {
    const takuya = await callJson<PhotographerView>("POST", "/photographers", { name: "Takuya" });
    const id = await addPhoto({ exif: { artist: "T. Yoshida" } });
    await callJson("POST", `/photographers/${takuya.id}/aliases`, { artist: "T. Yoshida", applyToExisting: false });
    const detail = await callJson<PhotoDetail>("GET", `/photos/${id}`);
    expect(detail.photographer).toBeNull();
    expect(detail.photographerSuggestion?.id).toBe(takuya.id);
  });

  it("leaves photos in place when a photographer is deleted", async () => {
    const takuya = await callJson<PhotographerView>("POST", "/photographers", { name: "Takuya" });
    const id = await addPhoto({ photographerId: takuya.id });
    await call("DELETE", `/photographers/${takuya.id}`);
    expect((await callJson<PhotoDetail>("GET", `/photos/${id}`)).photographer).toBeNull();
  });
});

describe("usage", () => {
  it("reports database size and photo count", async () => {
    await addPhoto();
    const usage = await callJson<LibraryUsage>("GET", "/storage/usage");
    expect(usage.photoCount).toBe(1);
    expect(usage.d1Bytes).toBeGreaterThan(0);
    expect(usage.bytesPerPhoto).toBe(usage.d1Bytes);
    expect(usage.warning).toBe(false);
    await addPhoto();
    expect((await callJson<LibraryUsage>("GET", "/storage/usage")).photoCount).toBe(2);
  });

  it("keeps the daily samples as history", async () => {
    await recordUsage(env.PHOTOS_DB);
    const { results } = await env.PHOTOS_DB.prepare("SELECT photo_count FROM usage_samples").all();
    expect(results).toEqual([{ photo_count: 0 }]);
  });
});
