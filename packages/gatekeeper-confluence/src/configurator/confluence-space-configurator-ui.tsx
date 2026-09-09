import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConfluenceSpaceConfiguratorRpc,
  ConfluenceSpaceConfiguratorValues,
} from "./confluence-space-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.spaceUrl === "string" && values.spaceUrl.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return resourceUrl ? { spaceUrl: resourceUrl } : {};
  },

  resourceUrl({ values }) {
    return values.spaceUrl ?? "";
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-confluence.confluence-space-configurator-ui.space")} description={t("gatekeeper-confluence.confluence-space-configurator-ui.search_the_spaces_shared_with_this_connection")}>
        <Autocomplete
          name="spaceUrl"
          value={values.spaceUrl}
          placeholder={t("gatekeeper-confluence.confluence-space-configurator-ui.search_spaces")}
          loadOptions={query => ui.listSpaces(query)}
          onChange={spaceUrl => setValues({ spaceUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluenceSpaceConfiguratorRpc, ConfluenceSpaceConfiguratorValues>;
