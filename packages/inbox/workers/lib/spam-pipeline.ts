import type { Env } from "../types";
import type { MailboxDO } from "../durableObject";
import { getConfigStub } from "./config";
import { classify, tokenize } from "./bayes";
import { checkDNSBL, scoreHeuristics, totalScore } from "./spam";
import { evaluateSpamRules, type EmailContext, type SpamRule } from "./rules";
import { scoreAuthentication } from "./authentication";
import {
  assembleVerdict,
  matchSenderRule,
  senderDomain,
  MAX_SPAM_SCORE,
  type Classification,
  type RemovedAttachment,
  type SpamPolicy,
  type StageScore,
} from "./spam-policy";

const DNSBL_SCORE = 30; // Preserve the pre-existing DNS blocklist score without adding reputation machinery.
const BAYES_NEUTRAL_PROBABILITY = 0.5; // Preserve the existing Bayesian correction around neutral.
const BAYES_SCORE_RANGE = 80; // Preserve the existing maximum +/-40 point correction.
const REMOVED_ATTACHMENT_SCORE = 20; // Inspection findings contribute without causing loss of mail.
const RATE_LIMIT_SCORE = 50; // A burst is explainable spam, regardless of the aggregate cutoff.

/** Extend the legacy classifier with envelope lists, authentication, rate and inspection stages. */
export async function classifyIncoming(
  env: Env,
  stub: DurableObjectStub<MailboxDO>,
  input: {
    messageId: string;
    envelope: string;
    headers: [string, string][];
    email: EmailContext;
    attachments: { filename: string; mimetype: string }[];
    removed: RemovedAttachment[];
    policy: SpamPolicy;
  },
): Promise<Classification> {
  try {
    const { email, policy } = input;
    const stages: StageScore[] = [];
    const base = {
      message_id: input.messageId,
      envelope_sender: input.envelope.trim().toLowerCase(),
      mime_sender: email.from,
      removed_attachments: input.removed,
      policy,
      stages,
    };
    const senderRule = matchSenderRule(input.envelope, await stub.listSenderRules());
    if (senderRule) {
      stages.push({
        stage: "sender_list",
        score: 0,
        reason: `${senderRule.type}: ${senderRule.id}`,
      });
      return { ...base, score: 0, verdict: senderRule.type === "allow" ? "inbox" : "reject" };
    }
    const config = getConfigStub(env);
    const domain = senderDomain(input.envelope);
    if (await config.checkList("allow", domain ? [domain] : [])) {
      stages.push({ stage: "legacy_list", score: 0, reason: "allow" });
      return { ...base, score: 0, verdict: "inbox" };
    }
    const ruleRows = await stub.listSpamRules();
    const rules: SpamRule[] = ruleRows.map(
      /** Adapt the existing SQL declarative rule representation. */ (rule) => ({
        ...rule,
        enabled: !!rule.enabled,
        field: rule.field as SpamRule["field"],
        op: rule.op as SpamRule["op"],
      }),
    );
    const legacy = evaluateSpamRules(email, rules);
    if (legacy.verdict === "allow") {
      stages.push({ stage: "legacy_rules", score: 0, reason: `allow: ${legacy.matchedRuleId}` });
      return { ...base, score: 0, verdict: "inbox" };
    }
    const legacyBlock =
      !!(await config.checkList("block", domain ? [domain] : [])) || legacy.verdict === "block";
    // Preserve legacy block rules' recoverable spam behavior; only new sender blocks reject.
    stages.push({
      stage: "legacy_rules",
      score: legacyBlock ? MAX_SPAM_SCORE : legacy.scoreDelta,
      reason: legacyBlock ? "block (legacy spam filing)" : (legacy.matchedRuleId ?? "score rules"),
    });
    stages.push(...scoreAuthentication(input.headers, input.envelope, email.from));
    const heuristic = scoreHeuristics({
      subject: email.subject,
      from: email.from,
      from_display_name: email.from_display_name,
      body_text: email.body_text,
      headers: {},
      attachments: input.attachments,
      dangerous_extensions: policy.dangerous_extensions,
    });
    stages.push({
      stage: "heuristics",
      score: totalScore(heuristic),
      reason:
        heuristic
          .map(/** Keep the legacy heuristic explanation. */ (signal) => signal.reason)
          .join("; ") || "該当なし",
    });
    // Keep the legacy domain check; Cloudflare still owns SMTP IP reputation and retries.
    const dnsListed = domain ? await checkDNSBL(domain) : false;
    stages.push({
      stage: "dnsbl",
      score: dnsListed ? DNSBL_SCORE : 0,
      reason: dnsListed ? "既存DNSブロックリストに一致" : "該当なし",
    });
    const tokens = tokenize(`${email.subject}\n${email.body_text}`);
    const { counts, totals } = await stub.bayesLookup(tokens);
    const bayesScore =
      totals.spam + totals.ham > 0
        ? Math.round(
            (classify(tokens, counts, totals) - BAYES_NEUTRAL_PROBABILITY) * BAYES_SCORE_RANGE,
          )
        : 0;
    stages.push({
      stage: "bayes",
      score: bayesScore,
      reason: totals.spam + totals.ham > 0 ? "学習済みベイズ補正" : "未学習（中立）",
    });
    const rate = await stub.recordInboundRate(input.envelope, policy, Date.now());
    stages.push({
      stage: "rate",
      score: rate.exceeded ? RATE_LIMIT_SCORE : 0,
      reason: `address=${rate.address_count}/${policy.rate_address_limit}, domain=${rate.domain_count}/${policy.rate_domain_limit}, window_ms=${policy.rate_window_ms}`,
    });
    stages.push({
      stage: "attachments",
      score: input.removed.length ? REMOVED_ATTACHMENT_SCORE : 0,
      reason: `removed=${input.removed.length}`,
    });
    return {
      ...base,
      ...assembleVerdict(stages, policy, legacyBlock || rate.exceeded || input.removed.length > 0),
    };
  } catch (err) {
    console.error("[classifyIncoming] failed", { messageId: input.messageId, err });
    throw err;
  }
}
