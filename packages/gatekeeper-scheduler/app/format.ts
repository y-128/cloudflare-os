import { getLocale, translate, type TranslationParams } from "@gadgets/i18n";
import type { ManagementSchedule } from "../src/management-types";
import type { ScheduleCadence, Weekday } from "../src/types";

const WEEKDAYS: Record<Weekday, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Binds message lookup to the same locale used for the date and time. */
function translator(locale: string) {
  return (key: string, params?: TranslationParams) => translate(locale.startsWith("ja") ? "ja" : "en", key, params);
}

export type ScheduleTiming = {
  relative: string;
  absolute?: string;
  diagnostic?: string;
};

export function formatCadence(cadence: ScheduleCadence, locale = getLocale()): string {
  const t = translator(locale);
  if (cadence.kind === "interval") return formatInterval(cadence.everyMs, locale);
  if (cadence.kind === "once") {
    const date = new Intl.DateTimeFormat(locale, {
      timeZone: cadence.timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(cadence.fireAt);
    const time = new Intl.DateTimeFormat(locale, {
      timeZone: cadence.timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(cadence.fireAt);
    return t("gatekeeper-scheduler.format.once_on_at", { date, time });
  }

  const { rule } = cadence;
  if (rule.freq === "hourly") {
    return t("gatekeeper-scheduler.format.every_hours_at", { n: rule.interval, minute: rule.minute.toString().padStart(2, "0") });
  }
  const time = formatClock(rule.hour, rule.minute, locale);
  if (rule.freq === "daily") {
    return t("gatekeeper-scheduler.format.every_days_at", { n: rule.interval, time });
  }
  if (rule.interval === 1 && rule.byDay.join(",") === "MO,TU,WE,TH,FR") {
    return t("gatekeeper-scheduler.format.weekdays_at", { time });
  }
  const days = new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(
    rule.byDay.map((day) => new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2020, 0, 5 + WEEKDAYS[day]))),
  );
  return t("gatekeeper-scheduler.format.every_weeks_on_at", { n: rule.interval, days, time });
}

/** Describes a finite recurrence bound and, for a counted bound, progress toward it. */
export function formatOccurrences(
  schedule: ManagementSchedule,
  locale = getLocale(),
): string | undefined {
  const t = translator(locale);
  const bound = schedule.occurrences;
  if (!bound) return undefined;
  if ("count" in bound) {
    return t("gatekeeper-scheduler.format.of_occurrences", { done: schedule.occurrenceCount ?? 0, n: bound.count });
  }
  return t("gatekeeper-scheduler.format.until", { time: formatAbsolute(bound.until, scheduleTimeZone(schedule), locale) });
}

export function formatTiming(
  schedule: ManagementSchedule,
  now = Date.now(),
  locale = getLocale(),
): ScheduleTiming {
  const t = translator(locale);
  const timestamp = scheduleTimestamp(schedule);
  if (timestamp === undefined) return { relative: t("gatekeeper-scheduler.format.next_run_pending") };
  const absolute = formatAbsolute(timestamp, scheduleTimeZone(schedule), locale);
  if (schedule.status === "active") {
    return {
      relative: schedule.retrying ? t("gatekeeper-scheduler.format.next_retry", { time: formatRelative(timestamp - now, locale) }) : t("gatekeeper-scheduler.format.next_run", { time: formatRelative(timestamp - now, locale) }),
      absolute,
    };
  }
  if (schedule.status === "dead") {
    return {
      relative: t("gatekeeper-scheduler.format.failed", { time: formatRelative(schedule.failedAt - now, locale) }),
      absolute,
      diagnostic:
        schedule.failureCode === "authorization_failed"
          ? t("gatekeeper-scheduler.format.authorization_failed_after_retries")
          : t("gatekeeper-scheduler.format.task_callback_failed_after_retries"),
    };
  }
  if (schedule.status === "completed") {
    return {
      relative: t("gatekeeper-scheduler.format.completed", { time: formatRelative(schedule.completedAt - now, locale) }),
      absolute,
      diagnostic: schedule.occurrences
        ? t("gatekeeper-scheduler.format.this_recurring_task_used_its_last_scheduled_occurrence")
        : t("gatekeeper-scheduler.format.this_one_time_task_completed"),
    };
  }
  return {
    relative: t("gatekeeper-scheduler.format.expired", { time: formatRelative(schedule.expiredAt - now, locale) }),
    absolute,
    diagnostic: schedule.cadence.kind === "once"
      ? t("gatekeeper-scheduler.format.this_one_time_task_passed_without_delivery")
      : t("gatekeeper-scheduler.format.this_recurring_task_s_cutoff_passed_before_its_first_occurrence"),
  };
}

function formatInterval(milliseconds: number, locale: string): string {
  const t = translator(locale);
  const units = [
    [7 * 24 * 60 * 60_000, "week"],
    [24 * 60 * 60_000, "day"],
    [60 * 60_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ] as const;
  const [unitMs, unit] = units.find(([size]) => milliseconds % size === 0) ?? [1, "millisecond"];
  const count = milliseconds / unitMs;
  return t("gatekeeper-scheduler.format.every", { duration: new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(count) });
}

function formatClock(hour: number, minute: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(Date.UTC(2020, 0, 1, hour, minute));
}

function formatRelative(milliseconds: number, locale: string): string {
  const absolute = Math.abs(milliseconds);
  const [size, unit] =
    absolute >= 24 * 60 * 60_000
      ? ([24 * 60 * 60_000, "day"] as const)
      : absolute >= 60 * 60_000
        ? ([60 * 60_000, "hour"] as const)
        : absolute >= 60_000
          ? ([60_000, "minute"] as const)
          : ([1_000, "second"] as const);
  const value = Math.round(milliseconds / size);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit);
}

function formatAbsolute(timestamp: number, timeZone: string | undefined, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(timestamp);
}

function scheduleTimestamp(schedule: ManagementSchedule): number | undefined {
  if (schedule.status === "active") return schedule.nextFire;
  if (schedule.status === "dead") return schedule.failedAt;
  if (schedule.status === "completed") return schedule.completedAt;
  return schedule.expiredAt;
}

function scheduleTimeZone(schedule: ManagementSchedule): string | undefined {
  return schedule.cadence.kind === "interval" ? undefined : schedule.cadence.timeZone;
}
