import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  NotionItemConfiguratorRpc,
  NotionItemConfiguratorValues,
} from "./notion-item-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.itemUrl === "string" && values.itemUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { itemUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.itemUrl ?? "";
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="ページまたはデータベース"
        description="この接続で共有されている Notion ページとデータベースを検索するか、Notion URL を貼り付けます。"
      >
        <Autocomplete
          name="itemUrl"
          value={values.itemUrl}
          placeholder="Notionを検索…"
          loadOptions={query => ui.listItems(query)}
          onChange={itemUrl => setValues({ itemUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NotionItemConfiguratorRpc, NotionItemConfiguratorValues>;
