import { opendir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCommand, AgentFile } from "./protocol.ts";
import type { AgentEvent } from "./control.ts";
import { renderDerivatives } from "./derive.ts";
import { describeFile, isPhoto, resolveInside, sha256File } from "./files.ts";
import { log } from "./log.ts";
import { writeTarget } from "./upload.ts";

/** Files per scan-result message. */
const SCAN_BATCH = 25;

/** Every photo under a folder, depth first, skipping hidden and NAS system folders. */
export async function* walk(folder: string): AsyncGenerator<string> {
  for await (const entry of await opendir(folder)) {
    if (entry.name.startsWith(".") || entry.name.startsWith("@")) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && isPhoto(entry.name)) yield path;
  }
}

/** Carries out one worker command, reporting the outcome as events. */
export async function runCommand(root: string, command: AgentCommand, emit: (event: AgentEvent) => void): Promise<void> {
  try {
    switch (command.type) {
      case "scan": {
        const folder = await resolveInside(root, command.folder);
        let batch: AgentFile[] = [];
        for await (const path of walk(folder)) {
          try {
            batch.push(await describeFile(root, path));
          } catch (err) {
            log("warn", "skipped unreadable file", { path, error: err });
          }
          if (batch.length >= SCAN_BATCH) {
            emit({ type: "scan-result", jobId: command.jobId, files: batch, done: false });
            batch = [];
          }
        }
        emit({ type: "scan-result", jobId: command.jobId, files: batch, done: true });
        return;
      }
      case "derive": {
        const { preview, thumbnail } = await renderDerivatives(await resolveInside(root, command.path));
        await writeTarget(command.preview, preview.bytes, "image/jpeg");
        await writeTarget(command.thumbnail, thumbnail.bytes, "image/webp");
        emit({ type: "derived", jobId: command.jobId, photoId: command.photoId, preview: preview.spec, thumbnail: thumbnail.spec });
        return;
      }
      case "replicate": {
        const path = await resolveInside(root, command.path);
        await writeTarget(command.upload, { path, size: (await stat(path)).size }, "application/octet-stream");
        emit({ type: "replicated", jobId: command.jobId, assetId: command.assetId });
        return;
      }
      case "delete-after-verify": {
        const path = await resolveInside(root, command.path);
        // The replica was checked against this hash; delete only bytes that still match it.
        if (await sha256File(path) !== command.expectedSha256) throw new Error("hash_mismatch");
        await unlink(path);
        log("info", "moved original deleted from NAS", { path: command.path });
        emit({ type: "deleted", jobId: command.jobId, assetId: command.assetId });
        return;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("warn", "command failed", { type: command.type, seq: command.seq, error: message });
    emit({ type: "failed", jobId: command.jobId, seq: command.seq, error: message });
  }
}
