// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:

import { scoreAuthentication } from "./authentication";
const SUBJECT_STYLE_SCORE = 5; // 強調された件名の加点
const SUSPICIOUS_LINK_SCORE = 10; // 不審なリンクや通貨記号の加点
const BRAND_MISMATCH_SCORE = 15; // 表示名と送信ドメインが不一致の加点
const DANGEROUS_ATTACHMENT_SCORE = 20; // 危険な拡張子を持つ添付の加点
const UPPERCASE_RATIO_THRESHOLD = 0.6; // 大文字が多い件名と判定する比率
const MIN_SUBJECT_LENGTH = 8; // 大文字比率を判定する件名の最小長
const REPEATED_SIGNAL_THRESHOLD = 3; // 記号や短縮URLの繰り返し閾値
const MAX_SPAM_SCORE = 100; // 迷惑メール点数の上限

//     https://opensource.org/licenses/Apache-2.0

/**
 * Lightweight heuristic spam scoring (0-100). Workers-compatible, JS-only.
 */

import { domainOf } from "../../shared/email-address";

export interface SpamSignal {
  score: number;
  reason: string;
}

const DANGEROUS_EXTENSIONS = new Set([
  "exe",
  "scr",
  "bat",
  "cmd",
  "com",
  "pif",
  "vbs",
  "vbe",
  "js",
  "jse",
  "ws",
  "wsf",
  "wsc",
  "wsh",
  "ps1",
  "psm1",
  "msi",
  "msp",
  "hta",
  "jar",
]);

const SHORT_URL_HOSTS = [
  "bit.ly",
  "tinyurl.com",
  "goo.gl",
  "t.co",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "adf.ly",
  "bl.ink",
  "shorte.st",
  "cutt.ly",
];

/** scoreHeuristics の処理を実行します。 */ export function scoreHeuristics(input: {
  subject: string;
  from: string;
  from_display_name: string;
  body_text: string;
  headers: Record<string, string>;
  attachments: { filename: string; mimetype: string }[];
  dangerous_extensions?: string[];
}): SpamSignal[] {
  const signals: SpamSignal[] = [];
  signals.push(...scoreAuthentication(Object.entries(input.headers), "", "").filter(
    /** Preserve legacy heuristic callers while recording only actual failures. */ (stage) => stage.score > 0,
  ));

  if (/!{3,}/.test(input.subject))
    signals.push({ score: SUBJECT_STYLE_SCORE, reason: "Multiple exclamation marks in subject" });
  const upperRatio = countUpper(input.subject) / Math.max(input.subject.length, 1);
  if (upperRatio > UPPERCASE_RATIO_THRESHOLD && input.subject.length > MIN_SUBJECT_LENGTH)
    signals.push({ score: SUBJECT_STYLE_SCORE, reason: "Subject is mostly UPPERCASE" });
  if (
    /[$¥€£]/.test(input.subject) &&
    (input.subject.match(/[$¥€£]/g)?.length ?? 0) >= REPEATED_SIGNAL_THRESHOLD
  ) {
    signals.push({ score: SUSPICIOUS_LINK_SCORE, reason: "Many currency symbols in subject" });
  }

  const bareIp = /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/g;
  if (bareIp.test(input.body_text))
    signals.push({ score: SUSPICIOUS_LINK_SCORE, reason: "Bare-IP link in body" });

  const shortLinks = (input.body_text.match(/https?:\/\/([^\s/]+)/g) || [])
    .map(
      /** input.body_text.matchhttpssg.map callback のコールバックを実行します。 */ (u) =>
        u.replace(/^https?:\/\//, "").toLowerCase(),
    )
    .filter(
      /** matchhttpssg.mapuu.replacehttps.toLowerCase.filter callback のコールバックを実行します。 */ (
        host,
      ) =>
        SHORT_URL_HOSTS.some(
          /** SHORT_URL_HOSTS.some callback のコールバックを実行します。 */ (s) =>
            host === s || host.endsWith(`.${s}`),
        ),
    );
  if (shortLinks.length >= REPEATED_SIGNAL_THRESHOLD)
    signals.push({ score: SUSPICIOUS_LINK_SCORE, reason: "Many shortened URLs" });

  // Display name vs From-domain mismatch (e.g. "PayPal" <noreply@evil.tld>)
  const fromDom = domainOf(input.from) || "";
  const dn = input.from_display_name.toLowerCase();
  const brandNames = [
    "paypal",
    "amazon",
    "apple",
    "google",
    "microsoft",
    "rakuten",
    "amex",
    "visa",
  ];
  for (const brand of brandNames) {
    if (dn.includes(brand) && !fromDom.includes(brand)) {
      signals.push({
        score: BRAND_MISMATCH_SCORE,
        reason: `Display name mentions "${brand}" but From domain is ${fromDom}`,
      });
      break;
    }
  }

  for (const a of input.attachments) {
    const ext = a.filename.split(".").pop()?.toLowerCase() || "";
    if (input.dangerous_extensions ? input.dangerous_extensions.includes(`.${ext}`) : DANGEROUS_EXTENSIONS.has(ext)) {
      signals.push({ score: DANGEROUS_ATTACHMENT_SCORE, reason: `Dangerous attachment .${ext}` });
    }
  }

  return signals;
}

/** countUpper の処理を実行します。 */ function countUpper(s: string): number {
  let n = 0;
  for (const ch of s) if (ch >= "A" && ch <= "Z") n++;
  return n;
}

/** totalScore の処理を実行します。 */ export function totalScore(signals: SpamSignal[]): number {
  return Math.min(
    MAX_SPAM_SCORE,
    Math.max(
      0,
      signals.reduce(
        /** signals.reduce callback のコールバックを実行します。 */ (acc, s) => acc + s.score,
        0,
      ),
    ),
  );
}
