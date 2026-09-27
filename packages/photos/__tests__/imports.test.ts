import { beforeEach, describe, expect, it } from "vitest";
import type { AgentFile } from "../shared/agent-protocol";
import type {
  ImportJobView, ImportOptions, PhotoDetail, StorageConnectionView,
} from "../shared/api-types";
import type { StorageConnectionId } from "../shared/ids";
import { onlineAgent, outsideFetch, putTarget, settle } from "./agent-helpers";
import { addPhoto, call, callJson, env, resetDb } from "./helpers";

beforeEach(resetDb);

const file = (path: string, bytes: string, extra: Partial<AgentFile> = {}): AgentFile => ({
  path, size: bytes.length, mtime: 1_700_000_000_000, sha256: [...bytes].map((c) => c.charCodeAt(0).toString(16)).join("").padEnd(64, "0").slice(0, 64),
  exif: { model: "ILCE-7M4", takenAt: 1_690_000_000_000 }, ...extra,
});

async function r2(): Promise<StorageConnectionId> {
  return (await callJson<StorageConnectionView>("POST", "/storage", { kind: "r2-binding", name: "R2", prefix: "cache" })).id;
}

/** Scans a folder with the fake agent answering with `files`. */
async function scanned(files: AgentFile[]) {
  const agent = await onlineAgent();
  const job = await callJson<ImportJobView>("POST", "/imports/scan", { connectionId: agent.id, folder: "2026/Event-A" });
  await settle();
  const [scan] = agent.commands("scan");
  expect(scan).toMatchObject({ jobId: job.id, folder: "2026/Event-A" });
  await agent.emit({ type: "scan-result", jobId: job.id, files, done: true });
  agent.socket.send(JSON.stringify({ type: "ack", seq: scan.seq }));
  return { agent, job: await callJson<ImportJobView>("GET", `/imports/${job.id}`) };
}

/** Plays the agent's part for every derive command it has received. */
async function deriveAll(agent: Awaited<ReturnType<typeof onlineAgent>>) {
  for (const command of agent.commands("derive")) {
    const preview = new TextEncoder().encode(`preview of ${command.path}`);
    const thumbnail = new TextEncoder().encode("thumb");
    expect((await putTarget(command.preview, preview)).status).toBe(204);
    expect((await putTarget(command.thumbnail, thumbnail)).status).toBe(204);
    await agent.emit({
      type: "derived", jobId: command.jobId, photoId: command.photoId,
      preview: { size: preview.byteLength, width: 2048, height: 1365 },
      thumbnail: { size: thumbnail.byteLength, width: 400, height: 267 },
    });
  }
}

async function start(jobId: string, options: ImportOptions) {
  return callJson<ImportJobView>("POST", `/imports/${jobId}/start`, { options });
}

describe("NAS imports", () => {
  it("scans, skips what the library has, and references the rest on the NAS", async () => {
    await addPhoto({ assets: [{ role: "original", connectionId: "stc_01J00000000000000000000000" as StorageConnectionId, storageKey: "elsewhere/x.jpg", mimeType: "image/jpeg", byteSize: 3, sha256: file("", "old").sha256 }] });
    const cache = await r2();
    const { agent, job } = await scanned([
      file("2026/Event-A/DSC1.JPG", "one"), file("2026/Event-A/DSC2.ARW", "two"), file("2026/Event-A/copy.jpg", "old"),
    ]);
    expect(job).toMatchObject({ state: "scanned", found: 3, newCount: 2, duplicates: 1 });

    expect((await call("POST", `/imports/${job.id}/start`, { body: { options: { mode: "copy", derivativeConnectionId: cache } } })).status).toBe(400);
    const running = await start(job.id, { mode: "reference", derivativeConnectionId: cache, visibility: "unlisted" });
    expect(running.state).toBe("running");
    await settle();
    expect(agent.commands("derive").map((c) => c.path)).toEqual(["2026/Event-A/DSC1.JPG", "2026/Event-A/DSC2.ARW"]);

    await deriveAll(agent);
    const done = await callJson<ImportJobView>("GET", `/imports/${job.id}`);
    expect(done).toMatchObject({ state: "succeeded", done: 2, failed: 0 });

    const photoId = agent.commands("derive")[1].photoId;
    const detail = await callJson<PhotoDetail>("GET", `/photos/${photoId}`);
    expect(detail).toMatchObject({ visibility: "unlisted", hasRaw: true, takenAt: 1_690_000_000_000, exif: { model: "ILCE-7M4" } });
    const original = detail.assets.find((a) => a.role === "original")!;
    expect(original).toMatchObject({ storageKey: "2026/Event-A/DSC2.ARW", connection: { kind: "nas", status: "online" } });
    expect(await (await outsideFetch(detail.previewUrl!)).text()).toBe("preview of 2026/Event-A/DSC2.ARW");
  });

  it("copies originals to R2 and, for move, deletes them from the NAS only after the replica checks out", async () => {
    const cache = await r2();
    for (const mode of ["copy", "move"] as const) {
      const bytes = `${mode} bytes`;
      const { agent, job } = await scanned([file(`2026/${mode}.JPG`, bytes)]);
      await start(job.id, { mode, derivativeConnectionId: cache, replicaConnectionId: cache });
      await settle();
      await deriveAll(agent);
      const [replicate] = agent.commands("replicate");
      expect(replicate.path).toBe(`2026/${mode}.JPG`);
      expect((await putTarget(replicate.upload, new TextEncoder().encode(bytes))).status).toBe(204);
      await agent.emit({ type: "replicated", jobId: job.id, assetId: replicate.assetId });

      const photoId = agent.commands("derive")[0].photoId;
      let detail = await callJson<PhotoDetail>("GET", `/photos/${photoId}`);
      expect(detail.assets.find((a) => a.role === "replica")).toMatchObject({ connection: { kind: "r2-binding" } });

      if (mode === "copy") {
        expect(agent.commands("delete-after-verify")).toEqual([]);
        expect((await callJson<ImportJobView>("GET", `/imports/${job.id}`)).state).toBe("succeeded");
        continue;
      }
      const [remove] = agent.commands("delete-after-verify");
      expect(remove).toMatchObject({ path: "2026/move.JPG", expectedSha256: file("", bytes).sha256 });
      await agent.emit({ type: "deleted", jobId: job.id, assetId: remove.assetId });
      detail = await callJson<PhotoDetail>("GET", `/photos/${photoId}`);
      const originals = detail.assets.filter((a) => a.role === "original");
      expect(originals).toHaveLength(1);
      expect(originals[0].connection.kind).toBe("r2-binding");
      expect(detail.assets.some((a) => a.role === "replica")).toBe(false);
      expect((await callJson<ImportJobView>("GET", `/imports/${job.id}`)).state).toBe("succeeded");
    }
  });

  it("does not register a replica whose size is wrong", async () => {
    const cache = await r2();
    const { agent, job } = await scanned([file("a.JPG", "expected")]);
    await start(job.id, { mode: "copy", derivativeConnectionId: cache, replicaConnectionId: cache });
    await settle();
    await deriveAll(agent);
    const [replicate] = agent.commands("replicate");
    // A short write is refused outright; one that never happens fails the check on report.
    expect((await putTarget(replicate.upload, new TextEncoder().encode("short"))).status).toBe(400);
    await agent.emit({ type: "replicated", jobId: job.id, assetId: replicate.assetId });
    const view = await callJson<ImportJobView>("GET", `/imports/${job.id}`);
    expect(view).toMatchObject({ failed: 1, failures: [{ path: "a.JPG", error: "replica_mismatch" }] });
  });

  it("records agent failures and retries them", async () => {
    const cache = await r2();
    const { agent, job } = await scanned([file("broken.JPG", "x")]);
    await start(job.id, { mode: "reference", derivativeConnectionId: cache });
    await settle();
    const [derive] = agent.commands("derive");
    await agent.emit({ type: "failed", jobId: job.id, seq: derive.seq, error: "unsupported image" });
    expect(await callJson<ImportJobView>("GET", `/imports/${job.id}`)).toMatchObject({
      state: "succeeded", failed: 1, failures: [{ path: "broken.JPG", error: "unsupported image" }],
    });
    await call("POST", `/imports/${job.id}/retry`);
    await settle();
    expect(agent.commands("derive")).toHaveLength(2);
    expect((await callJson<ImportJobView>("GET", `/imports/${job.id}`)).state).toBe("running");
  });

  it("imports new files from the watched folder when auto import is on", async () => {
    const cache = await r2();
    const agent = await onlineAgent();
    await agent.emit({ type: "file-discovered", file: file("Incoming/ignored.JPG", "a") });
    expect(agent.commands("derive")).toEqual([]);

    await callJson("PATCH", `/storage/${agent.id}`, { autoImport: { mode: "reference", derivativeConnectionId: cache, tagIds: [] } });
    await agent.emit({ type: "file-discovered", file: file("Incoming/new.JPG", "b") });
    await agent.emit({ type: "file-discovered", file: file("Incoming/new-again.JPG", "b") });
    expect(agent.commands("derive").map((c) => c.path)).toEqual(["Incoming/new.JPG"]);
    const [job] = await callJson<ImportJobView[]>("GET", "/imports");
    expect(job).toMatchObject({ automatic: true, state: "running", found: 2, duplicates: 1 });
    agent.socket.close(1000, "done");
    await settle(200);
  });

  it("keeps folder paths inside the library", async () => {
    const agent = await onlineAgent();
    for (const folder of ["/etc", "../outside", "a/../../b"]) {
      expect((await call("POST", "/imports/scan", { body: { connectionId: agent.id, folder } })).status).toBe(400);
    }
    await env.PHOTOS_DB.prepare("SELECT 1").run();
  });
});
