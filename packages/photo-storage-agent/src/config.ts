import { readFileSync } from "node:fs";

/** /config/agent.json, read once at startup (never watched, so the disk can sleep). */
export interface AgentConfig {
  /** Public origin of Cloudflare OS, e.g. https://os.example.com. */
  serverUrl: string;
  /** The NAS storage connection this agent serves (shown when it was created). */
  connectionId: string;
  /** Library root inside the container; every path the worker names is relative to it. */
  libraryRoot: string;
  /** Watched folder relative to the root, or null to watch nothing. */
  incomingFolder: string | null;
  /** Where cloudflared forwards the tunnel hostname to. */
  listenHost: string;
  listenPort: number;
  /** Keys created by `pair`. Kept on the config volume, which should be on SSD or flash if possible. */
  stateFile: string;
  /** Cloudflare Access service token for reaching Cloudflare OS itself, when Access guards it. */
  access?: { clientId: string; clientSecret: string };
  /** Offer everything already in the watched folder once at startup (catches files added while down). */
  rescanIncomingOnStart: boolean;
}

const DEFAULTS = {
  libraryRoot: "/data",
  incomingFolder: "Incoming",
  listenHost: "0.0.0.0",
  listenPort: 8080,
  stateFile: "/config/state.json",
  rescanIncomingOnStart: true,
} satisfies Partial<AgentConfig>;

/** Loads and checks the configuration file. */
export function loadConfig(path = process.env.PHOTO_AGENT_CONFIG ?? "/config/agent.json"): AgentConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentConfig>;
  const config = { ...DEFAULTS, ...raw } as AgentConfig;
  const server = config.serverUrl ?? "";
  if (!server.startsWith("https://") && !/^http:\/\/localhost[:/]/.test(server)) {
    throw new Error("serverUrl must be the https:// origin of Cloudflare OS");
  }
  if (!/^stc_[0-9A-Z]{26}$/.test(config.connectionId ?? "")) throw new Error("connectionId must be the NAS connection's id (stc_…)");
  config.serverUrl = config.serverUrl.replace(/\/+$/, "");
  return config;
}
