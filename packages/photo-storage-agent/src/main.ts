#!/usr/bin/env node
import { existsSync } from "node:fs";
import { runCommand } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { ControlChannel } from "./control.ts";
import { generateKeys, readState, writeState } from "./keys.ts";
import { log } from "./log.ts";
import type { PairingResult } from "./protocol.ts";
import { createFileServer } from "./server.ts";
import { watchIncoming } from "./watcher.ts";

const VERSION = "1.0.0";

async function pair(code: string): Promise<void> {
  const config = loadConfig();
  const keys = await generateKeys();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.access) {
    headers["CF-Access-Client-Id"] = config.access.clientId;
    headers["CF-Access-Client-Secret"] = config.access.clientSecret;
  }
  const response = await fetch(`${config.serverUrl}/api/photos/v1/agent/pair`, {
    method: "POST",
    headers,
    body: JSON.stringify({ connectionId: config.connectionId, code, publicKey: keys.publicKey }),
  });
  if (!response.ok) throw new Error(`pairing failed (${response.status}); create a new pairing code and try again`);
  const result = await response.json() as PairingResult;
  writeState(config.stateFile, { ...keys, agentKey: result.agentKey });
  log("info", "paired", { connectionId: result.connectionId });
}

function run(): void {
  const config = loadConfig();
  if (!existsSync(config.stateFile)) throw new Error("not paired yet: run `photo-storage-agent pair <code>` first");
  const state = readState(config.stateFile);
  const server = createFileServer({ root: config.libraryRoot, agentKey: () => state.agentKey, version: VERSION });
  server.listen(config.listenPort, config.listenHost, () => log("info", "serving originals", { port: config.listenPort }));
  const channel = new ControlChannel(config, state, VERSION, (command) =>
    runCommand(config.libraryRoot, command, (event) => channel.emit(event)));
  channel.start();
  if (config.incomingFolder) {
    watchIncoming(config.libraryRoot, config.incomingFolder, (file) => channel.emit({ type: "file-discovered", file }),
      config.rescanIncomingOnStart);
  }
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === "pair" && argument) await pair(argument);
  else if (command === "run" || command === undefined) run();
  else {
    process.stderr.write("usage: photo-storage-agent pair <code> | run\n");
    process.exit(2);
  }
} catch (err) {
  log("error", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
