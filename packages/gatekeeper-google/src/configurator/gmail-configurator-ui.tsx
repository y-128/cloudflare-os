import { t } from "@gadgets/configurator-ui";
import { Field, h, RadioCards, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GmailConfiguratorRpc, GmailConfiguratorValues } from "./gmail-configurator-types";

export default {
  initial: { mode: "all" },

  isReady({ values }) {
    const mode = values.mode ?? "all";
    if (mode === "all") return true;
    if (mode === "search") return typeof values.query === "string" && values.query.trim().length > 0;
    if (mode === "label") return typeof values.label === "string" && values.label.trim().length > 0;
    return false;
  },

  // Must mirror `parseGmailUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  initialValuesFromResourceUrl({ resourceUrl }) {
    const hash = new URL(resourceUrl).hash.replace(/^#/, "");
    if (hash.startsWith("search/")) {
      // Gmail encodes spaces in hash searches as `+`, which decodeURIComponent leaves alone. The
      // substitution has to precede the decode so an escaped `%2B` still yields a literal `+`.
      const query = hash.slice("search/".length).replace(/\+/g, " ");
      return { mode: "search", query: decodeURIComponent(query) };
    }
    if (hash.startsWith("label/")) {
      return { mode: "label", label: decodeURIComponent(hash.slice("label/".length)) };
    }
    return { mode: "all" };
  },

  resourceUrl({ values }) {
    const mode = values.mode ?? "all";
    if (mode === "search") {
      return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(values.query ?? "")}`;
    }
    if (mode === "label") {
      return `https://mail.google.com/mail/u/0/#label/${encodeURIComponent(values.label ?? "")}`;
    }
    return "https://mail.google.com/mail/u/0/";
  },

  render({ values, setValues, clearFields }) {
    const mode = values.mode ?? "all";
    return <Section>
      <Field label={t("gatekeeper-google.gmail-configurator-ui.mailbox_scope")} description={t("gatekeeper-google.gmail-configurator-ui.choose_whether_this_connection_can_access_all_gmail_messages_or")}>
        <RadioCards
          value={mode}
          options={[
            { value: "all", title: t("gatekeeper-google.gmail-configurator-ui.all_gmail"), description: t("gatekeeper-google.gmail-configurator-ui.allow_access_to_the_whole_mailbox") },
            { value: "search", title: t("gatekeeper-google.gmail-configurator-ui.search"), description: t("gatekeeper-google.gmail-configurator-ui.allow_messages_matching_a_gmail_search_query") },
            { value: "label", title: t("gatekeeper-google.gmail-configurator-ui.label"), description: t("gatekeeper-google.gmail-configurator-ui.allow_messages_with_a_specific_gmail_label") },
          ]}
          onChange={nextMode => {
            if (nextMode !== "all" && nextMode !== "search" && nextMode !== "label") return;
            clearFields("query", "label");
            setValues({ mode: nextMode, query: null, label: null });
          }}
        />
      </Field>

      {mode === "search" && <Field label={t("gatekeeper-google.gmail-configurator-ui.search_query")} description={t("gatekeeper-google.gmail-configurator-ui.use_the_same_query_syntax_as_gmail_search")}>
        <TextInput
          name="query"
          value={values.query}
          placeholder={t("gatekeeper-google.gmail-configurator-ui.from_alerts_example_com_newer_than_30d")}
          onChange={query => setValues({ query })}
        />
      </Field>}

      {mode === "label" && <Field label={t("gatekeeper-google.gmail-configurator-ui.label")} description={t("gatekeeper-google.gmail-configurator-ui.use_the_gmail_label_name_exactly_as_it_appears_in_gmail")}>
        <TextInput
          name="label"
          value={values.label}
          placeholder={t("gatekeeper-google.gmail-configurator-ui.receipts")}
          onChange={label => setValues({ label })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<GmailConfiguratorRpc, GmailConfiguratorValues>;
