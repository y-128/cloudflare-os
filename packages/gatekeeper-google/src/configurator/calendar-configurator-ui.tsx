import { Autocomplete, Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CalendarConfiguratorRpc, CalendarConfiguratorValues } from "./calendar-configurator-types";

export default {
  initial: { availabilityMode: "thisCalendar" },

  isReady({ values }) {
    return typeof values.calendarId === "string" && values.calendarId.length > 0;
  },

  resourceUrl({ values }) {
    const calendarId = encodeURIComponent(values.calendarId ?? "");
    const availabilityMode = values.availabilityMode === "allVisible" ? "allVisible" : "thisCalendar";
    return `https://calendar.google.com/calendar/${calendarId}/?availability=${availabilityMode}`;
  },

  render({ values, setValues, ui }) {
    const availabilityMode = values.availabilityMode === "allVisible" ? "allVisible" : "thisCalendar";
    return <Section>
      <Field label="カレンダー" description="この接続が読み取りおよび管理できるカレンダーを選択します。">
        <Autocomplete
          name="calendarId"
          value={values.calendarId}
          placeholder="カレンダーを検索…"
          loadOptions={query => ui.listCalendars(query)}
          onChange={calendarId => setValues({ calendarId })}
        />
      </Field>

      <Field
        label="空き状況の検索"
        description="空き時間チェックでは、ビジー/空きブロックのみが表示され、イベントの詳細は表示されません。"
      >
        <RadioCards
          value={availabilityMode}
          options={[
            {
              value: "thisCalendar",
              title: "This calendar only",
              description: "Check availability for this calendar only.",
            },
            {
              value: "allVisible",
              title: "All calendars visible to me",
              description: "Check anyone visible to your account. Collaborators must also be able to see their availability.",
            },
          ]}
          onChange={nextMode => {
            if (nextMode !== "thisCalendar" && nextMode !== "allVisible") return;
            setValues({ availabilityMode: nextMode });
          }}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CalendarConfiguratorRpc, CalendarConfiguratorValues>;
