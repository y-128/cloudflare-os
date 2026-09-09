import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CalendarConfiguratorRpc, CalendarConfiguratorValues } from "./calendar-configurator-types";

export default {
  initial: { availabilityMode: "thisCalendar" },

  isReady({ values }) {
    return typeof values.calendarId === "string" &&
      values.calendarId.length > 0 && values.calendarId !== "primary";
  },

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const parsed = new URL(resourceUrl);
    const calendarId = decodeURIComponent(parsed.pathname.split("/")[2] ?? "");
    return {
      calendarId: calendarId === "primary" ? await ui.getPrimaryCalendarId() : calendarId,
      availabilityMode: parsed.searchParams.get("availability") === "allVisible"
        ? "allVisible" : "thisCalendar",
    };
  },

  resourceUrl({ values }) {
    const calendarId = encodeURIComponent(values.calendarId ?? "");
    const availabilityMode = values.availabilityMode === "allVisible" ? "allVisible" : "thisCalendar";
    return `https://calendar.google.com/calendar/${calendarId}/?availability=${availabilityMode}`;
  },

  render({ values, setValues, ui }) {
    const availabilityMode = values.availabilityMode === "allVisible" ? "allVisible" : "thisCalendar";
    return <Section>
      <Field label={t("gatekeeper-google.calendar-configurator-ui.calendar")} description={t("gatekeeper-google.calendar-configurator-ui.choose_the_calendar_this_connection_can_read_and_manage")}>
        <Autocomplete
          name="calendarId"
          value={values.calendarId}
          placeholder={t("gatekeeper-google.calendar-configurator-ui.search_calendars")}
          loadOptions={query => ui.listCalendars(query)}
          onChange={calendarId => setValues({ calendarId })}
        />
      </Field>

      <Field
        label={t("gatekeeper-google.calendar-configurator-ui.availability_lookup")}
        description={t("gatekeeper-google.calendar-configurator-ui.free_busy_checks_show_only_busy_free_blocks_never_event_details")}
      >
        <RadioCards
          value={availabilityMode}
          options={[
            {
              value: "thisCalendar",
              title: t("gatekeeper-google.calendar-configurator-ui.this_calendar_only"),
              description: t("gatekeeper-google.calendar-configurator-ui.check_availability_for_this_calendar_only"),
            },
            {
              value: "allVisible",
              title: t("gatekeeper-google.calendar-configurator-ui.all_calendars_visible_to_me"),
              description: t("gatekeeper-google.calendar-configurator-ui.check_anyone_visible_to_your_account_collaborators_must_also_be_a"),
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
