import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GoogleDocConfiguratorRpc, GoogleDocConfiguratorValues } from "./google-doc-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.docId === "string" && values.docId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://docs.google.com/document/d/${encodeURIComponent(values.docId ?? "")}/edit`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-google.google-doc-configurator-ui.document")} description={t("gatekeeper-google.google-doc-configurator-ui.search_recent_documents_from_drive")}>
        <Autocomplete
          name="docId"
          value={values.docId}
          placeholder={t("gatekeeper-google.google-doc-configurator-ui.search_recent_docs")}
          loadOptions={query => ui.listDocs(query)}
          onChange={docId => setValues({ docId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GoogleDocConfiguratorRpc, GoogleDocConfiguratorValues>;
