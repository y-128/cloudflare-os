import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentFile } from "./protocol.ts";
import { walk } from "./commands.ts";
import { describeFile, isPhoto } from "./files.ts";
import { log } from "./log.ts";

/** A file is complete once its size and mtime hold still this long. */
export const SETTLE_MS = 10 * 1000;

/**
 * Watches the Incoming folder with inotify (fs.watch), so nothing polls the disk while it is
 * idle: an HDD can spin down and stays down until a file actually arrives.
 */
export function watchIncoming(root: string, folder: string, onFile: (file: AgentFile) => void, rescan: boolean): void {
  const base = join(root, folder);
  const pending = new Map<string, { timer: NodeJS.Timeout; size: number; mtime: number }>();

  const check = async (path: string) => {
    const info = await stat(path).catch(() => null);
    const last = pending.get(path);
    if (!info?.isFile() || !last) {
      pending.delete(path);
      return;
    }
    if (info.size !== last.size || info.mtimeMs !== last.mtime) {
      // Still being written: wait another settle period.
      pending.set(path, { timer: setTimeout(() => void check(path), SETTLE_MS), size: info.size, mtime: info.mtimeMs });
      return;
    }
    pending.delete(path);
    try {
      onFile(await describeFile(root, path));
    } catch (err) {
      log("warn", "could not read new file", { path, error: err });
    }
  };

  watch(base, { recursive: true }, (_event, name) => {
    if (!name || !isPhoto(name.toString())) return;
    const path = join(base, name.toString());
    clearTimeout(pending.get(path)?.timer);
    pending.set(path, { timer: setTimeout(() => void check(path), SETTLE_MS), size: -1, mtime: -1 });
  });
  log("info", "watching for new photos", { folder });

  if (rescan) {
    void (async () => {
      for await (const path of walk(base)) {
        try {
          onFile(await describeFile(root, path));
        } catch (err) {
          log("warn", "could not read file", { path, error: err });
        }
      }
    })();
  }
}
