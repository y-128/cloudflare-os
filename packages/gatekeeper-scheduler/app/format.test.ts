import { t } from "@gadgets/i18n";
import { describe, expect, it } from "vitest";
import { formatCadence, formatOccurrences, formatTiming } from "./format";
import type { ManagementSchedule } from "../src/management-types";

const common = {
  scheduleId: "schedule-a",
  title: "Morning brief",
  description: "Prepare the morning brief.",
  workspaceId: "a".repeat(64),
};

describe("formatCadence", () => {
  it("describes interval, weekday, and one-shot schedules", () => {
    expect(formatCadence({ kind: "interval", everyMs: 3_600_000, anchorMs: 0 })).toBe(t("gatekeeper-scheduler.format.every", { duration: "1 時間" }));
    expect(
      formatCadence({
        kind: "calendar",
        timeZone: "America/Chicago",
        rule: {
          freq: "weekly",
          interval: 1,
          byDay: ["MO", "TU", "WE", "TH", "FR"],
          hour: 8,
          minute: 0,
          anchorMs: 0,
        },
      }),
    ).toBe(t("gatekeeper-scheduler.format.weekdays_at", { time: "8:00" }));
    expect(
      formatCadence({
        kind: "once",
        fireAt: Date.UTC(2026, 6, 30, 14),
        timeZone: "America/Chicago",
      }),
    ).toBe(t("gatekeeper-scheduler.format.once_on_at", { date: "2026年7月30日", time: "9:00" }));
  });
});

describe("formatTiming", () => {
  it("uses bounded status copy and relative timestamps", () => {
    const now = Date.UTC(2026, 6, 30, 12);
    const active: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
      nextFire: now + 2 * 3_600_000,
    };
    const dead: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "dead",
      failedAt: now - 60_000,
      failureCode: "authorization_failed",
    };

    expect(formatTiming(active, now).relative).toBe(t("gatekeeper-scheduler.format.next_run", { time: "2 時間後" }));
    expect(formatTiming(dead, now)).toMatchObject({
      relative: t("gatekeeper-scheduler.format.failed", { time: "1 分前" }),
      diagnostic: t("gatekeeper-scheduler.format.authorization_failed_after_retries"),
    });
  });

  it("does not invent an absolute time while the next run is pending", () => {
    const active: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
    };

    expect(formatTiming(active, Date.UTC(2026, 6, 30, 12))).toEqual({
      relative: t("gatekeeper-scheduler.format.next_run_pending"),
    });
  });

  it("marks a retry so it is not mistaken for a new occurrence", () => {
    const now = Date.UTC(2026, 6, 30, 12);
    const retrying: ManagementSchedule = {
      ...common,
      cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
      status: "active",
      nextFire: now + 5 * 60_000,
      retrying: true,
    };

    expect(formatTiming(retrying, now).relative).toBe(t("gatekeeper-scheduler.format.next_retry", { time: "5 分後" }));
  });
});

describe("formatOccurrences", () => {
  const hourly = {
    ...common,
    cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
    status: "active",
    nextFire: 0,
  } as const satisfies Partial<ManagementSchedule> as ManagementSchedule;

  it("reports progress toward a counted bound", () => {
    expect(formatOccurrences({ ...hourly, occurrences: { count: 3 }, occurrenceCount: 1 }))
      .toBe(t("gatekeeper-scheduler.format.of_occurrences", { done: 1, n: 3 }));
    expect(formatOccurrences({ ...hourly, occurrences: { count: 1 } }))
      .toBe(t("gatekeeper-scheduler.format.of_occurrences", { done: 0, n: 1 }));
  });

  it("renders a time bound in the schedule's own timezone", () => {
    const until = Date.UTC(2026, 7, 3, 13);
    const calendar: ManagementSchedule = {
      ...hourly,
      cadence: {
        kind: "calendar",
        timeZone: "America/New_York",
        rule: { freq: "daily", interval: 1, hour: 9, minute: 0, anchorMs: 0 },
      },
      occurrences: { until },
    };

    // Rendered in the cadence's zone, not UTC: 13:00Z is 9am in New York.
    expect(formatOccurrences(calendar, "en")).toContain("Aug 3, 2026");
    expect(formatOccurrences(calendar, "en")).toContain("EDT");
  });

  it("omits a bound the schedule does not have", () => {
    expect(formatOccurrences(hourly)).toBeUndefined();
  });
});

describe("formatTiming terminal copy", () => {
  const base = {
    ...common,
    cadence: { kind: "interval", everyMs: 3_600_000, anchorMs: 0 },
    status: "completed",
    completedAt: 0,
  } as const satisfies Partial<ManagementSchedule> as ManagementSchedule;

  it("distinguishes a used bound from a delivered one-shot", () => {
    expect(formatTiming({ ...base, occurrences: { count: 2 } }, 0).diagnostic)
      .toBe(t("gatekeeper-scheduler.format.this_recurring_task_used_its_last_scheduled_occurrence"));
    expect(
      formatTiming(
        { ...base, cadence: { kind: "once", fireAt: 0, timeZone: "UTC" } },
        0,
      ).diagnostic,
    ).toBe(t("gatekeeper-scheduler.format.this_one_time_task_completed"));
  });

  it("explains a recurrence that expired before its first occurrence", () => {
    const expired = { ...base, status: "expired", expiredAt: 0 } as ManagementSchedule;

    expect(formatTiming(expired, 0).diagnostic)
      .toBe(t("gatekeeper-scheduler.format.this_recurring_task_s_cutoff_passed_before_its_first_occurrence"));
  });
});
