// Adapted for @gadgets/inbox: standalone Worker conventions and explicit error handling.
// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Generic mail-rule engine. Used both by user filters (move/star/label/forward)
 * and by spam declarative rules.
 */

import { domainOf, localPartOf } from "../../shared/email-address";

export type Op =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "matches"
  | "regex"
  | "in_list";

export type Field =
  | "from"
  | "from_full"
  | "from_local"
  | "from_domain"
  | "from_display_name"
  | "to"
  | "cc"
  | "subject"
  | "body"
  | "subaddress"
  | "has_attachment"
  | `header:${string}`;

export interface Predicate {
  field: Field;
  op: Op;
  value: string;
}

export interface MatchGroup {
  all_of?: Predicate[];
  any_of?: Predicate[];
}

export type FilterAction =
  | { type: "move"; folder_id: string }
  | { type: "mark_read" }
  | { type: "star" }
  | { type: "label"; value: string }
  | { type: "forward_to"; address: string; keep_original?: boolean };

export interface FilterRule {
  id: string;
  priority: number;
  enabled: boolean;
  match: MatchGroup;
  actions: FilterAction[];
  name?: string;
}

export interface SpamRule {
  id: string;
  priority: number;
  enabled: boolean;
  field: Field;
  op: Op;
  value: string;
  action: "allow" | "block" | string; // also `add_score:N` / `subtract_score:N`
}

export interface EmailContext {
  from: string;
  from_display_name: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body_text: string;
  subaddress: string | null;
  has_attachment: boolean;
  headers: Record<string, string>;
}

/** getField の処理を実行します。 */ function getField(
  email: EmailContext,
  field: Field,
): string | string[] | boolean {
  if (field.startsWith("header:")) {
    const name = field.slice("header:".length).toLowerCase();
    return email.headers[name] || "";
  }
  switch (field) {
    case "from":
    case "from_full":
      return email.from;
    case "from_local":
      return localPartOf(email.from);
    case "from_domain":
      return domainOf(email.from) || "";
    case "from_display_name":
      return email.from_display_name;
    case "to":
      return email.to;
    case "cc":
      return email.cc;
    case "subject":
      return email.subject;
    case "body":
      return email.body_text;
    case "subaddress":
      return email.subaddress || "";
    case "has_attachment":
      return email.has_attachment;
  }
  return "";
}

/** globToRegex の処理を実行します。 */ function globToRegex(g: string): RegExp {
  const escaped = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** evaluatePredicate の処理を実行します。 */ export function evaluatePredicate(
  email: EmailContext,
  p: Predicate,
): boolean {
  const raw = getField(email, p.field);
  const haystack =
    typeof raw === "boolean" ? (raw ? "true" : "false") : Array.isArray(raw) ? raw.join(" ") : raw;
  const needle = p.value;

  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();

  switch (p.op) {
    case "equals":
      return h === n;
    case "not_equals":
      return h !== n;
    case "contains":
      return h.includes(n);
    case "not_contains":
      return !h.includes(n);
    case "starts_with":
      return h.startsWith(n);
    case "ends_with":
      return h.endsWith(n);
    case "matches":
      return globToRegex(needle).test(haystack);
    case "regex":
      try {
        return new RegExp(needle, "i").test(haystack);
      } catch (caught) {
        console.error("[evaluatePredicate] 失敗", {
          context: { operation: "evaluatePredicate" },
          err: caught,
        });

        return false;
      }
    case "in_list":
      return needle
        .split(/[\s,]+/)
        .map(
          /** needle.splits.map callback のコールバックを実行します。 */ (s) =>
            s.trim().toLowerCase(),
        )
        .filter(Boolean)
        .includes(h);
  }
  return false;
}

/** evaluateMatch の処理を実行します。 */ export function evaluateMatch(
  email: EmailContext,
  m: MatchGroup,
): boolean {
  if (m.all_of && m.all_of.length > 0) {
    if (
      !m.all_of.every(
        /** m.all_of.every callback のコールバックを実行します。 */ (p) =>
          evaluatePredicate(email, p),
      )
    )
      return false;
  }
  if (m.any_of && m.any_of.length > 0) {
    if (
      !m.any_of.some(
        /** m.any_of.some callback のコールバックを実行します。 */ (p) =>
          evaluatePredicate(email, p),
      )
    )
      return false;
  }
  return Boolean(m.all_of?.length || m.any_of?.length);
}

/** findMatchingRules の処理を実行します。 */ export function findMatchingRules(
  email: EmailContext,
  rules: FilterRule[],
): FilterRule[] {
  return rules
    .filter(/** rules.filter callback のコールバックを実行します。 */ (r) => r.enabled)
    .toSorted(
      /** rules.filterrr.enabled.sort callback のコールバックを実行します。 */ (a, b) =>
        a.priority - b.priority,
    )
    .filter(
      /** filterrr.enabled.sortaba.priorityb.priority.filter callback のコールバックを実行します。 */ (
        r,
      ) => evaluateMatch(email, r.match),
    );
}

export interface SpamDecision {
  verdict: "allow" | "block" | null;
  scoreDelta: number;
  matchedRuleId: string | null;
}

/** evaluateSpamRules の処理を実行します。 */ export function evaluateSpamRules(
  email: EmailContext,
  rules: SpamRule[],
): SpamDecision {
  const sorted = rules
    .filter(/** rules.filter callback のコールバックを実行します。 */ (r) => r.enabled)
    .toSorted(
      /** rules.filterrr.enabled.sort callback のコールバックを実行します。 */ (a, b) =>
        a.priority - b.priority,
    );
  let scoreDelta = 0;
  for (const r of sorted) {
    if (!evaluatePredicate(email, { field: r.field, op: r.op, value: r.value })) continue;
    if (r.action === "allow") return { verdict: "allow", scoreDelta, matchedRuleId: r.id };
    if (r.action === "block") return { verdict: "block", scoreDelta, matchedRuleId: r.id };
    const m = r.action.match(/^add_score:(-?\d+)/);
    if (m) {
      scoreDelta += Number(m[1]);
      continue;
    }
    const s = r.action.match(/^subtract_score:(-?\d+)/);
    if (s) {
      scoreDelta -= Number(s[1]);
      continue;
    }
  }
  return { verdict: null, scoreDelta, matchedRuleId: null };
}
