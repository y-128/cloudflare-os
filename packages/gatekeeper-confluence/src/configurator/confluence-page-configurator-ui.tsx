import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConfluencePageConfiguratorRpc,
  ConfluencePageConfiguratorValues,
} from "./confluence-page-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.pageUrl === "string" && values.pageUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { pageUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.pageUrl ?? "";
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="ページまたはブログ投稿"
        description="この接続で共有されているページとブログ投稿を検索するか、Confluence URL を貼り付けます。"
      >
        <Autocomplete
          name="pageUrl"
          value={values.pageUrl}
          placeholder="Confluenceを検索…"
          loadOptions={query => ui.listPages(query)}
          onChange={pageUrl => setValues({ pageUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluencePageConfiguratorRpc, ConfluencePageConfiguratorValues>;
