import { t } from "@gadgets/configurator-ui";
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
        label={t("gatekeeper-confluence.confluence-page-configurator-ui.page_or_blog_post")}
        description={t("gatekeeper-confluence.confluence-page-configurator-ui.search_the_pages_and_blog_posts_shared_with_this_connection_or_p")}
      >
        <Autocomplete
          name="pageUrl"
          value={values.pageUrl}
          placeholder={t("gatekeeper-confluence.confluence-page-configurator-ui.search_confluence")}
          loadOptions={query => ui.listPages(query)}
          onChange={pageUrl => setValues({ pageUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluencePageConfiguratorRpc, ConfluencePageConfiguratorValues>;
