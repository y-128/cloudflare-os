// Logs go to stdout only: writing log files would spin up NAS disks that could be asleep. Docker's
// logging driver decides where stdout goes (the example compose file discards it).

type Level = "debug" | "info" | "warn" | "error";

const quiet = process.env.PHOTO_AGENT_LOG === "quiet";

/** Writes one structured log line. */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (quiet && (level === "debug" || level === "info")) return;
  const error = fields.error instanceof Error ? { error: fields.error.message } : {};
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields, ...error })}\n`);
}
