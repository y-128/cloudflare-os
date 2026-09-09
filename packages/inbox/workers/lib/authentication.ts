import { senderDomain, type StageScore } from "./spam-policy";

export const AUTH_FAILURE_SCORE = 20; // Preserve the existing weight for each failed mechanism.
export const ENVELOPE_MISMATCH_SCORE = 15; // Forwarding can cause mismatches, so this alone is neutral filing.
type AuthVerdict = "pass" | "fail" | "unknown";
export type AuthenticationResults = Record<"spf" | "dkim" | "dmarc", AuthVerdict>;

/** Remove quoted strings and nested comments so their contents cannot impersonate verdicts. */
function removeAuthComments(value: string): string | null {
  let result = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && (depth > 0 || quoted)) {
      escaped = true;
      continue;
    }
    if (character === '"' && depth === 0) {
      quoted = !quoted;
      result += " ";
      continue;
    }
    if (quoted) continue;
    if (character === "(") {
      depth++;
      result += " ";
      continue;
    }
    if (character === ")") {
      if (depth === 0) return null;
      depth--;
      continue;
    }
    if (depth === 0) result += character;
  }
  return depth || quoted || escaped ? null : result;
}

/** Parse event-header verdicts; missing, malformed and unrecognized results remain unknown. */
export function parseAuthenticationResults(headers: [string, string][]): AuthenticationResults {
  const result: AuthenticationResults = { spf: "unknown", dkim: "unknown", dmarc: "unknown" };
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "authentication-results") continue;
    const cleaned = removeAuthComments(value);
    if (cleaned === null) continue;
    const [authority, ...clauses] = cleaned.split(";");
    if (!/^\s*[a-z0-9_.-]+(?:\s+\d+)?\s*$/i.test(authority)) continue;
    for (const clause of clauses) {
      const match = /^\s*(spf|dkim|dmarc)(?:\/\d+)?\s*=\s*(pass|fail)(?=\s|$)/i.exec(clause);
      if (!match) continue;
      const mechanism = match[1].toLowerCase() as keyof AuthenticationResults;
      const verdict = match[2].toLowerCase() as "pass" | "fail";
      // Multiple signatures/headers never erase an observed failure with a later pass.
      if (result[mechanism] !== "fail") result[mechanism] = verdict;
    }
  }
  return result;
}

/** Score each authentication mechanism separately and compare envelope versus MIME domains. */
export function scoreAuthentication(
  headers: [string, string][],
  envelope: string,
  mimeFrom: string,
): StageScore[] {
  const verdicts = parseAuthenticationResults(headers);
  const stages: StageScore[] = Object.entries(verdicts).map(
    /** Record unknown explicitly rather than treating it as pass. */ ([mechanism, verdict]) => ({
      stage: mechanism,
      score: verdict === "fail" ? AUTH_FAILURE_SCORE : 0,
      reason: verdict,
    }),
  );
  const envelopeDomain = senderDomain(envelope);
  const mimeDomain = senderDomain(mimeFrom);
  const mismatch = !!envelopeDomain && !!mimeDomain && envelopeDomain !== mimeDomain;
  stages.push({
    stage: "envelope",
    score: mismatch ? ENVELOPE_MISMATCH_SCORE : 0,
    reason: mismatch
      ? "SMTPとFromのドメインが一致しません。"
      : envelopeDomain && mimeDomain
        ? "一致"
        : "unknown",
  });
  return stages;
}
