import { t, useTranslation } from "@gadgets/i18n";
import {
  CalendarBlank,
  CaretDown,
  Clock,
  MagnifyingGlass,
  Plus,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ScheduleManagementClient,
  ManagementSchedule,
} from "../src/management-types";
import type { ScheduleStatus } from "../src/types";
import { formatCadence, formatOccurrences, formatTiming } from "./format";

export const CREATE_SCHEDULE_PROMPT =
  () => {
  return t("gatekeeper-scheduler.SchedulerPage.help_me_create_a_scheduled_task_ask_me_what_it_should_do_which_wo");
};

const STARTERS = [
  {
    get title() { return t("gatekeeper-scheduler.SchedulerPage.daily_brief"); },
    get cadence() { return t("gatekeeper-scheduler.SchedulerPage.weekdays_at_8_00_am"); },
    get description() { return t("gatekeeper-scheduler.SchedulerPage.your_calendar_for_the_day_plus_the_unread_mail_that_needs_a_repl"); },
    get prompt() { return t("gatekeeper-scheduler.SchedulerPage.every_weekday_at_8_00_am_send_me_a_short_brief_of_my_calendar_for"); },
    icon: CalendarBlank,
  },
  {
    get title() { return t("gatekeeper-scheduler.SchedulerPage.weekly_roundup"); },
    get cadence() { return t("gatekeeper-scheduler.SchedulerPage.fridays_at_4_00_pm"); },
    get description() { return t("gatekeeper-scheduler.SchedulerPage.turn_the_week_s_linear_issues_and_github_pull_requests_into_a_st"); },
    get prompt() { return t("gatekeeper-scheduler.SchedulerPage.every_friday_at_4_00_pm_turn_this_week_s_linear_issues_and_github"); },
    icon: CalendarBlank,
  },
  {
    get title() { return t("gatekeeper-scheduler.SchedulerPage.follow_up_monitor"); },
    get cadence() { return t("gatekeeper-scheduler.SchedulerPage.weekdays_at_9_00_am"); },
    get description() { return t("gatekeeper-scheduler.SchedulerPage.flag_the_gmail_threads_that_are_waiting_on_your_reply"); },
    get prompt() { return t("gatekeeper-scheduler.SchedulerPage.every_weekday_at_9_00_am_flag_the_gmail_threads_that_are_waiting_"); },
    icon: WarningCircle,
  },
  {
    get title() { return t("gatekeeper-scheduler.SchedulerPage.metrics_snapshot"); },
    get cadence() { return t("gatekeeper-scheduler.SchedulerPage.mondays_at_8_00_am"); },
    get description() { return t("gatekeeper-scheduler.SchedulerPage.refresh_a_spreadsheet_or_query_and_call_out_what_moved"); },
    get prompt() { return t("gatekeeper-scheduler.SchedulerPage.every_monday_at_8_00_am_refresh_a_spreadsheet_or_query_and_call_o"); },
    icon: Clock,
  },
] as const;

type Filter = "all" | "active" | "dead" | "finished";

// Upper bound on one host title lookup, matching its per-call cap and our page size.
const MAX_TITLE_LOOKUP = 100;

export type { ScheduleManagementClient } from "../src/management-types";

type Props = {
  api: ScheduleManagementClient;
  openWorkspace: (workspaceId: string, gadgetId?: number) => void | Promise<void>;
  openPrompt: (prompt: string) => void | Promise<void>;
  // Resolves the live title of each workspace ID, or null when the user can no longer see it. The
  // schedule rows hold only IDs, so titles are never a stale snapshot.
  resolveWorkspaceTitles: (ids: string[]) => Promise<(string | null)[]>;
};

export default function SchedulerPage({
  api,
  openWorkspace,
  openPrompt,
  resolveWorkspaceTitles,
}: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [schedules, setSchedules] = useState<ManagementSchedule[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [workspaceTitles, setWorkspaceTitles] = useState<Map<string, string | null>>(
    () => new Map(),
  );
  const [now, setNow] = useState(Date.now());
  const request = useRef(0);
  const statuses = useMemo(() => statusesForFilter(filter), [filter]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const load = useCallback(
    async (nextCursor?: string) => {
      const epoch = ++request.current;
      if (nextCursor) setLoadingMore(true);
      else setLoading(true);
      setError(undefined);
      try {
        const page = await api.list({
          cursor: nextCursor,
          query: debouncedQuery || undefined,
          statuses,
        });
        if (epoch !== request.current) return;
        setSchedules((current) => (nextCursor ? [...current, ...page.schedules] : page.schedules));
        setCursor(page.cursor);
      } catch (caught) {
        if (epoch === request.current)
          setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (epoch === request.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [api, debouncedQuery, statuses],
  );

  useEffect(() => {
    setExpanded(new Set());
    void load();
  }, [load]);

  // Resolve titles for workspaces we haven't looked up yet. Failures leave the rows unresolved,
  // which renders as an unavailable target rather than breaking the list.
  useEffect(() => {
    // Capped at the host's per-call limit: a second page can land before the first lookup settles,
    // and an over-long request would be rejected outright. The rest is picked up on the next run.
    const missing = [
      ...new Set(schedules.map((s) => s.workspaceId).filter((id) => !workspaceTitles.has(id))),
    ].slice(0, MAX_TITLE_LOOKUP);
    if (missing.length === 0) return;
    let cancelled = false;
    resolveWorkspaceTitles(missing)
      .then((titles) => {
        if (cancelled) return;
        setWorkspaceTitles((current) => {
          const next = new Map(current);
          missing.forEach((id, index) => next.set(id, titles[index] ?? null));
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [schedules, workspaceTitles, resolveWorkspaceTitles]);

  const runHostAction = useCallback(async (action: () => void | Promise<void>) => {
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  // The account has no schedules at all: "all" spans every status, so an empty unfiltered page
  // means there is nothing for the search field or the status tabs to act on.
  const isEmpty =
    !loading && !error && schedules.length === 0 && !debouncedQuery && filter === "all";
  return (
    <main className="mx-auto min-h-full w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-12">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">
            {t("gatekeeper-scheduler.SchedulerPage.scheduled_tasks")}</h1>
          <p className="mt-1 text-sm text-kumo-subtle">
            {t("gatekeeper-scheduler.SchedulerPage.wake_a_workspace_and_run_its_code_on_a_schedule_you_choose")}</p>
        </div>
        <button
          type="button"
          data-action="create-schedule"
          className="press inline-flex h-9 items-center justify-center gap-2 self-start rounded-lg bg-kumo-brand px-3.5 text-sm font-medium text-white hover:bg-kumo-brand-hover"
          onClick={() => void runHostAction(() => openPrompt(CREATE_SCHEDULE_PROMPT()))}
        >
          <Plus size={16} weight="bold" />{t("gatekeeper-scheduler.SchedulerPage.create_schedule")}</button>
      </header>

      {!isEmpty && (
        <>
          <label className="mt-4 flex h-9 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-control px-3 text-kumo-inactive focus-within:ring-2 focus-within:ring-kumo-ring">
            <MagnifyingGlass size={15} />
            <span className="sr-only">{t("gatekeeper-scheduler.SchedulerPage.search_scheduled_tasks")}</span>
            <input
              className="min-w-0 flex-1 bg-transparent text-sm text-kumo-default outline-none placeholder:text-kumo-inactive"
              type="search"
              value={query}
              maxLength={200}
              placeholder={t("gatekeeper-scheduler.SchedulerPage.search_scheduled_tasks_2")}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>

          <nav className="mt-4 flex gap-5 border-b border-kumo-line" aria-label={t("gatekeeper-scheduler.SchedulerPage.schedule_status")}>
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                data-filter={item.value}
                aria-current={filter === item.value ? "page" : undefined}
                className={`relative pb-2 text-sm ${filter === item.value ? "font-medium text-kumo-default" : "text-kumo-subtle hover:text-kumo-default"}`}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
                {filter === item.value && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 bg-kumo-brand" />
                )}
              </button>
            ))}
          </nav>
        </>
      )}

      <section aria-live="polite" aria-busy={loading} className={isEmpty ? undefined : "min-h-32"}>
        {loading ? (
          <p className="py-12 text-center text-sm text-kumo-subtle">{t("gatekeeper-scheduler.SchedulerPage.loading_scheduled_tasks")}</p>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-kumo-danger">{t("gatekeeper-scheduler.SchedulerPage.couldn_t_load_scheduled_tasks")}</p>
            <button
              className="text-sm font-medium text-kumo-link hover:text-kumo-brand-hover"
              onClick={() => void load()}
            >
              {t("gatekeeper-scheduler.SchedulerPage.try_again")}</button>
          </div>
        ) : isEmpty ? null : schedules.length === 0 ? (
          <p className="py-12 text-center text-sm text-kumo-subtle">
            {t("gatekeeper-scheduler.SchedulerPage.no_scheduled_tasks_match_these_filters")}</p>
        ) : (
          <div className="divide-y divide-kumo-line">
            {schedules.map((schedule) => {
              const rowKey = `${schedule.scheduleId}:${schedule.workspaceId}`;
              const detailsOpen = expanded.has(rowKey);
              const targetTitle = workspaceTitles.get(schedule.workspaceId) ?? null;
              return (
                <ScheduleRow
                  key={rowKey}
                  schedule={schedule}
                  targetTitle={targetTitle}
                  now={now}
                  expanded={detailsOpen}
                  onToggle={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(rowKey)) next.delete(rowKey);
                      else next.add(rowKey);
                      return next;
                    })
                  }
                  onOpen={() =>
                    void runHostAction(() => openWorkspace(schedule.workspaceId, schedule.gadgetId))
                  }
                />
              );
            })}
          </div>
        )}
        {!loading && !error && cursor && (
          <div className="flex justify-center py-5">
            <button
              type="button"
              data-action="load-more"
              disabled={loadingMore}
              className="rounded-lg border border-kumo-line bg-kumo-control px-4 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
              onClick={() => void load(cursor)}
            >
              {loadingMore ? t("gatekeeper-scheduler.SchedulerPage.loading") : t("gatekeeper-scheduler.SchedulerPage.load_more")}
            </button>
          </div>
        )}
      </section>

      <section className={isEmpty ? "mt-6" : "mt-8"} aria-labelledby="get-started-heading">
        <h2
          id="get-started-heading"
          className="text-xs font-medium uppercase tracking-[0.12em] text-kumo-inactive"
        >
          {t("gatekeeper-scheduler.SchedulerPage.get_started")}</h2>
        <div className="mt-3 grid gap-1">
          {STARTERS.map((starter) => {
            const Icon = starter.icon;
            return (
              <button
                key={starter.title}
                type="button"
                className="group flex items-center gap-3 rounded-lg px-1 py-2.5 text-left hover:bg-kumo-tint"
                onClick={() => void runHostAction(() => openPrompt(starter.prompt))}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
                  <Icon size={15} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-kumo-default">
                    {starter.title}{" "}
                    <span className="ml-1 font-normal text-kumo-inactive">{starter.cadence}</span>
                  </span>
                  <span className="block truncate text-xs text-kumo-subtle">
                    {starter.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function ScheduleRow({
  schedule,
  targetTitle,
  now,
  expanded,
  onToggle,
  onOpen,
}: {
  schedule: ManagementSchedule;
  // Live title of the workspace this schedule delivers into; null while it is still being
  // resolved, or when the workspace is gone.
  targetTitle: string | null;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const timing = formatTiming(schedule, now);
  const target = targetTitle ?? t("gatekeeper-scheduler.SchedulerPage.unavailable_workspace");
  // A workspace the user can no longer see has nothing to open.
  const unavailable = targetTitle === null;
  // Only failed schedules have something to expand: why they need attention. The caret is a sibling
  // of the open button, never nested inside it, so the rest of the row stays one click target.
  const needsAttention = schedule.status === "dead";
  return (
    <article className={`-mx-2 rounded-lg px-2 py-3 ${unavailable ? "" : "hover:bg-kumo-tint"}`}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-action="open-schedule"
          disabled={unavailable}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={onOpen}
        >
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${needsAttention ? "bg-kumo-danger-tint text-kumo-danger" : "bg-kumo-fill text-kumo-subtle"}`}
          >
            {needsAttention ? <WarningCircle size={16} /> : <Clock size={16} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-kumo-default">
              {schedule.title}
            </span>
            <span className="block truncate text-xs text-kumo-subtle">
              {[formatCadence(schedule.cadence), formatOccurrences(schedule), target]
                .filter(Boolean).join(" · ")}
              {/* Narrow screens drop the timing column, so carry the relative time here instead. */}
              <span className="sm:hidden"> · {timing.relative}</span>
            </span>
          </span>
          <span className="hidden shrink-0 text-right sm:block">
            <span
              className={`block text-xs ${needsAttention ? "text-kumo-danger" : "text-kumo-subtle"}`}
            >
              {timing.relative}
            </span>
            {timing.absolute && (
              <span className="block text-[11px] text-kumo-inactive">{timing.absolute}</span>
            )}
          </span>
        </button>
        {needsAttention && (
          <button
            type="button"
            data-action="toggle-diagnostic"
            aria-expanded={expanded}
            aria-label={(expanded ? t("gatekeeper-scheduler.SchedulerPage.hide_why_needs_attention", { name: schedule.title }) : t("gatekeeper-scheduler.SchedulerPage.show_why_needs_attention", { name: schedule.title }))}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-kumo-inactive hover:bg-kumo-fill hover:text-kumo-default"
            onClick={onToggle}
          >
            <CaretDown
              size={14}
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>
      {needsAttention && expanded && timing.diagnostic && (
        <p className="ml-12 mt-2 rounded-lg bg-kumo-elevated px-3 py-2.5 text-xs leading-5 text-kumo-danger">
          {timing.diagnostic}
        </p>
      )}
    </article>
  );
}

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", get label() { return t("gatekeeper-scheduler.SchedulerPage.all"); } },
  { value: "active", get label() { return t("gatekeeper-scheduler.SchedulerPage.active"); } },
  { value: "dead", get label() { return t("gatekeeper-scheduler.SchedulerPage.needs_attention"); } },
  { value: "finished", get label() { return t("gatekeeper-scheduler.SchedulerPage.finished"); } },
];

function statusesForFilter(filter: Filter): ScheduleStatus[] | undefined {
  if (filter === "all") return undefined;
  if (filter === "active") return ["active"];
  if (filter === "dead") return ["dead"];
  return ["completed", "expired"];
}
