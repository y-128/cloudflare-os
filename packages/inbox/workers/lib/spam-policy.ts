import { z } from "zod";

/** Preserve the existing spam cutoff; rejection requires multiple strong signals. */
export const DEFAULT_SPAM_THRESHOLD = 50;
export const DEFAULT_REJECT_THRESHOLD = 100;
export const MAX_SPAM_SCORE = 100;
/** Ten minutes tolerates normal conversations while identifying sustained bursts. */
export const DEFAULT_RATE_WINDOW_MS = 10 * 60 * 1000;
/** Address and domain limits differ because domains can host many legitimate senders. */
export const DEFAULT_ADDRESS_LIMIT = 30;
export const DEFAULT_DOMAIN_LIMIT = 100;
/** Keep individual files below 10 MiB and retained attachments below 20 MiB. */
export const DEFAULT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Retain at most one day's rate history so enlarging a window still counts prior mail. */
export const MAX_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_RULE_TEXT = 1024; // Bound user-authored rule metadata.
export const MAX_LIST_RULES = 1000; // Bound the work performed for each delivery.
export const MAX_LOG_PAGE = 100; // Bound classification log response size.
export const DEFAULT_LOG_PAGE = 25;
export const DEFAULT_DANGEROUS_EXTENSIONS = [
  ".exe",
  ".scr",
  ".com",
  ".pif",
  ".bat",
  ".cmd",
  ".js",
  ".jse",
  ".vbs",
  ".vbe",
  ".wsf",
  ".wsh",
  ".jar",
  ".msi",
  ".lnk",
  ".reg",
  ".hta",
  ".cpl",
  ".ws",
  ".wsc",
  ".ps1",
  ".psm1",
  ".msp",
];

const PolicyFields = z
  .object({
    spam_threshold: z.number().int().min(0).max(MAX_SPAM_SCORE).default(DEFAULT_SPAM_THRESHOLD),
    reject_threshold: z.number().int().min(1).max(MAX_SPAM_SCORE).default(DEFAULT_REJECT_THRESHOLD),
    rate_window_ms: z
      .number()
      .int()
      .positive()
      .max(MAX_RATE_WINDOW_MS)
      .default(DEFAULT_RATE_WINDOW_MS),
    rate_address_limit: z.number().int().positive().default(DEFAULT_ADDRESS_LIMIT),
    rate_domain_limit: z.number().int().positive().default(DEFAULT_DOMAIN_LIMIT),
    attachment_max_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_ATTACHMENT_BYTES)
      .default(DEFAULT_ATTACHMENT_BYTES),
    attachment_total_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_ATTACHMENT_BYTES)
      .default(DEFAULT_TOTAL_ATTACHMENT_BYTES),
    dangerous_extensions: z
      .array(
        z
          .string()
          .regex(/^\.[a-z0-9]+$/i)
          .transform(/** Normalize configurable extensions. */ (value) => value.toLowerCase()),
      )
      .max(MAX_LIST_RULES)
      .default(DEFAULT_DANGEROUS_EXTENSIONS),
  })
  .strict();
export const SpamPolicySchema = PolicyFields.refine(
  /** Require an ordered pair of classification thresholds. */ (policy) =>
    policy.reject_threshold > policy.spam_threshold,
  "拒否閾値は迷惑メール閾値より大きくしてください。",
);
export const SpamPolicyPatchSchema = PolicyFields.partial();
export type SpamPolicy = z.infer<typeof SpamPolicySchema>;

export const SenderRuleSchema = z
  .object({
    type: z.enum(["allow", "block"]),
    scope: z.enum(["address", "domain"]),
    pattern: z
      .string()
      .trim()
      .min(1)
      .max(MAX_RULE_TEXT)
      .transform(
        /** Fold rule patterns for exact case-insensitive comparison. */ (value) =>
          value.toLowerCase(),
      ),
    note: z.string().max(MAX_RULE_TEXT).default(""),
  })
  .strict()
  .superRefine(
    /** Reject wildcard and malformed sender patterns. */ (rule, ctx) => {
      const domainPattern =
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
      const valid =
        rule.scope === "domain"
          ? domainPattern.test(rule.pattern)
          : /^[^\s@<>*?]+@[^\s@]+$/.test(rule.pattern) &&
            domainPattern.test(senderDomain(rule.pattern));
      if (!valid)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "完全一致のメールアドレスまたはドメインを指定してください。",
        });
    },
  );
export type SenderRuleInput = z.infer<typeof SenderRuleSchema>;
export type SenderRule = SenderRuleInput & { id: string; created_at: string };
export type Verdict = "inbox" | "spam" | "reject";
export interface StageScore {
  stage: string;
  score: number;
  reason: string;
}
export interface RemovedAttachment {
  filename: string;
  size: number;
  reasons: string[];
}
export interface Classification {
  message_id: string;
  envelope_sender: string;
  mime_sender: string;
  score: number;
  verdict: Verdict;
  stages: StageScore[];
  removed_attachments: RemovedAttachment[];
  policy: SpamPolicy;
}

/** Extract a sender domain without removing plus-address tags. */
export function senderDomain(address: string): string {
  return /^[^\s@]+@([^\s@]+)$/.exec(address.trim().toLowerCase())?.[1] ?? "";
}

/** Match only the complete envelope address or its complete domain. */
export function matchSenderRule(sender: string, rules: SenderRule[]): SenderRule | undefined {
  const normalized = sender.trim().toLowerCase();
  const matches = rules.filter(
    /** Compare anchored, normalized values without substring matching. */ (rule) =>
      (rule.scope === "address" ? normalized : senderDomain(normalized)) ===
      rule.pattern.toLowerCase(),
  );
  return (
    matches.find(/** Give explicit allow rules precedence. */ (rule) => rule.type === "allow") ??
    matches[0]
  );
}

/** Assemble a bounded score, preserving recoverable bursts and stripped messages. */
export function assembleVerdict(stages: StageScore[], policy: SpamPolicy, recoverable = false) {
  const score = Math.max(
    0,
    Math.min(
      MAX_SPAM_SCORE,
      stages.reduce(
        /** Accumulate every recorded scoring contribution. */ (sum, stage) => sum + stage.score,
        0,
      ),
    ),
  );
  const verdict: Verdict = recoverable
    ? "spam"
    : score >= policy.reject_threshold
      ? "reject"
      : score >= policy.spam_threshold
        ? "spam"
        : "inbox";
  return { score, verdict };
}
