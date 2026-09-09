import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConfluenceSiteConfiguratorRpc,
  ConfluenceSiteConfiguratorValues,
} from "./confluence-site-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.siteUrl === "string" && values.siteUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { siteUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.siteUrl ?? "";
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-confluence.confluence-site-configurator-ui.confluence_site")} description={t("gatekeeper-confluence.confluence-site-configurator-ui.choose_the_confluence_site_to_connect")}>
        <Autocomplete
          name="siteUrl"
          value={values.siteUrl}
          placeholder={t("gatekeeper-confluence.confluence-site-configurator-ui.search_sites")}
          loadOptions={query => ui.listSites(query)}
          onChange={siteUrl => setValues({ siteUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluenceSiteConfiguratorRpc, ConfluenceSiteConfiguratorValues>;
