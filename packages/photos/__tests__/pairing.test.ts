import { beforeEach, describe, expect, it } from "vitest";
import type { PhotoDetail, PhotoSummary, RelatedPhotos } from "../shared/api-types";
import type { PhotoId } from "../shared/ids";
import { fileStem } from "../workers/db/pairing";
import { addPhoto, call, callJson, env, resetDb } from "./helpers";

beforeEach(resetDb);

const TAKEN = 1_750_000_000_000;

async function search(): Promise<PhotoSummary[]> {
  return (await callJson<{ items: PhotoSummary[] }>("POST", "/photos/search", { query: {} })).items;
}

describe("RAW+JPEG pairs", () => {
  it("matches file stems regardless of folder, extension and case", () => {
    expect(fileStem("2026/Event/DSC_0001.ARW")).toBe("dsc_0001");
    expect(fileStem("dsc_0001.jpg")).toBe("dsc_0001");
    expect(fileStem(".hidden")).toBe(".hidden");
  });

  it("offers the other half, merges it in, and splits it back out", async () => {
    const jpeg = await addPhoto({ filename: "DSC_0001.JPG", takenAt: TAKEN });
    const raw = await addPhoto({ filename: "DSC_0001.ARW", raw: true, takenAt: TAKEN + 500 });
    await addPhoto({ filename: "DSC_0002.ARW", raw: true, takenAt: TAKEN });
    await env.PHOTOS_DB.prepare("INSERT INTO tags (id, name, path, created_at) VALUES ('tag_01J00000000000000000000000', 'Event', '/event/', 0)").run();
    await env.PHOTOS_DB.prepare("INSERT INTO photo_tags (photo_id, tag_id) VALUES (?, 'tag_01J00000000000000000000000')").bind(raw).run();

    const related = await callJson<RelatedPhotos>("GET", `/photos/${jpeg}/related`);
    expect(related.pairCandidates.map((p) => p.id)).toEqual([raw]);
    expect(related.duplicates).toEqual([]);

    const merged = await callJson<PhotoDetail>("POST", `/photos/${jpeg}/merge`, { photoId: raw });
    expect(merged).toMatchObject({ hasRaw: true, tags: [{ name: "Event" }] });
    const originals = merged.assets.filter((a) => a.role === "original");
    expect(originals.map((a) => [a.formatFamily, a.isPrimary])).toEqual([["jpeg", true], ["raw", false]]);
    expect((await call("GET", `/photos/${raw}`)).status).toBe(404);
    expect((await search()).map((p) => p.id)).not.toContain(raw);

    const rawAsset = originals.find((a) => a.formatFamily === "raw")!;
    const split = await call("POST", `/photos/${jpeg}/split`, { body: { assetId: rawAsset.id } });
    expect(split.status).toBe(201);
    const separated = await split.json() as PhotoDetail;
    expect(separated).toMatchObject({ hasRaw: true, tags: [{ name: "Event" }], takenAt: TAKEN });
    expect(separated.assets.map((a) => [a.id, a.isPrimary])).toEqual([[rawAsset.id, true]]);
    const left = await callJson<PhotoDetail>("GET", `/photos/${jpeg}`);
    expect(left.hasRaw).toBe(false);

    // Nothing left to split, and a photo cannot swallow itself.
    const jpegAsset = left.assets.find((a) => a.role === "original")!;
    expect((await call("POST", `/photos/${jpeg}/split`, { body: { assetId: jpegAsset.id } })).status).toBe(409);
    expect((await call("POST", `/photos/${jpeg}/merge`, { body: { photoId: jpeg } })).status).toBe(400);
  });

  it("does not offer photos taken apart or with the same kind of file", async () => {
    const jpeg = await addPhoto({ filename: "IMG_1.JPG", takenAt: TAKEN });
    await addPhoto({ filename: "IMG_1.ARW", raw: true, takenAt: TAKEN + 60_000 });
    await addPhoto({ filename: "img_1.jpeg", takenAt: TAKEN });
    expect((await callJson<RelatedPhotos>("GET", `/photos/${jpeg}/related`)).pairCandidates).toEqual([]);
  });

  it("lists photos holding the same bytes as duplicates", async () => {
    const one = await addPhoto();
    const sha = (await callJson<PhotoDetail>("GET", `/photos/${one}`)).assets[0].sha256;
    const two = await addPhoto();
    await env.PHOTOS_DB.prepare("UPDATE photo_assets SET sha256 = ?, byte_size = (SELECT byte_size FROM photo_assets WHERE photo_id = ?) WHERE photo_id = ?")
      .bind(sha, one, two).run();
    expect((await callJson<RelatedPhotos>("GET", `/photos/${one}/related`)).duplicates.map((p) => p.id)).toEqual([two as PhotoId]);
    await call("DELETE", `/photos/${two}`);
    expect((await callJson<RelatedPhotos>("GET", `/photos/${one}/related`)).duplicates).toEqual([]);
  });
});
