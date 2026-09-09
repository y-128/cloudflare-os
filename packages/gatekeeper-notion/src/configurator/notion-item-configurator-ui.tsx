import { t } from "@gadgets/configurator-ui";
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
        label={t("gatekeeper-notion.notion-item-configurator-ui.page_or_database")}
        description={t("gatekeeper-notion.notion-item-configurator-ui.search_the_notion_pages_and_databases_shared_with_this_connectio")}
      >
        <Autocomplete
          name="itemUrl"
          value={values.itemUrl}
          placeholder={t("gatekeeper-notion.notion-item-configurator-ui.search_notion")}
          loadOptions={query => ui.listItems(query)}
          onChange={itemUrl => setValues({ itemUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NotionItemConfiguratorRpc, NotionItemConfiguratorValues>;
