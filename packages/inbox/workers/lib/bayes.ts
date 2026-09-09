// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:

const MIN_TOKEN_LENGTH = 2; // 学習対象トークンの最小文字数
const MAX_TOKEN_LENGTH = 32; // 学習対象トークンの最大文字数
const MAX_TOKENS = 200; // 一通から抽出する最大トークン数
const NEUTRAL_PROBABILITY = 0.5; // 学習情報がないときの中立確率

//     https://opensource.org/licenses/Apache-2.0

/**
 * Robinson's f(w) Naive-Bayes spam classifier (paulgraham-style).
 * Trained per-mailbox via "this is spam" / "this is not spam" user feedback.
 */

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "with",
  "as",
  "by",
  "from",
  "your",
  "my",
  "our",
  "their",
  "これ",
  "それ",
  "あれ",
  "の",
  "は",
  "が",
  "を",
  "に",
  "へ",
  "で",
  "と",
  "も",
]);

/** tokenize の処理を実行します。 */ export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Split on whitespace + punctuation, keep CJK as-is
  const tokens = text
    .toLowerCase()
    // oxlint-disable-next-line no-control-regex -- パスとヘッダーの制御文字を意図的に除去します。
    .replace(/[\u0000-\u001f\r\n\t]+/g, " ")
    .split(/[\s,;:!?。、！？「」『』()[\]{}<>"'`/\\|=*+#@$%^&]+/)
    .filter(
      /** text.toLowerCase.replacerntg.splits.filter callback のコールバックを実行します。 */ (t) =>
        t.length >= MIN_TOKEN_LENGTH && t.length <= MAX_TOKEN_LENGTH && !STOPWORDS.has(t),
    );
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

export interface TokenCounts {
  spam_count: number;
  ham_count: number;
}

/**
 * Compute the spam probability for an email body using Robinson's f(w).
 *
 * @param tokens - unique tokens from the email
 * @param counts - per-token spam/ham counts from training data
 * @param totals - total trained spam / ham emails
 * @returns score 0..1 (higher = spammier)
 */
export function classify(
  tokens: string[],
  counts: Record<string, TokenCounts>,
  totals: { spam: number; ham: number },
): number {
  if (tokens.length === 0 || (totals.spam === 0 && totals.ham === 0)) return NEUTRAL_PROBABILITY;
  const sPrior = Math.max(totals.spam, 1);
  const hPrior = Math.max(totals.ham, 1);

  // f(w) per token, biased toward 0.5 when sample is small.
  const fws: number[] = [];
  for (const t of tokens) {
    const c = counts[t];
    if (!c) continue;
    const total = c.spam_count + c.ham_count;
    if (total === 0) continue;
    const bw =
      Math.min(1, c.spam_count / sPrior) /
      (Math.min(1, c.spam_count / sPrior) + Math.min(1, c.ham_count / hPrior));
    // Robinson's degree-of-belief smoothing (s=1, x=0.5)
    const s = 1;
    const x = NEUTRAL_PROBABILITY;
    const fw = (s * x + total * bw) / (s + total);
    fws.push(fw);
  }

  if (fws.length === 0) return NEUTRAL_PROBABILITY;

  // Robinson's combining: f = 1 - prod(1 - fw), g = prod(fw)
  let pProd = 1;
  let qProd = 1;
  for (const fw of fws) {
    pProd *= 1 - fw;
    qProd *= fw;
  }
  const n = fws.length;
  const P = 1 - Math.pow(pProd, 1 / n);
  const Q = 1 - Math.pow(qProd, 1 / n);
  return (1 + (P - Q) / (P + Q)) / 2;
}
