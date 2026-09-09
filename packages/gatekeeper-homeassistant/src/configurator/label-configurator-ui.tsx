import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantLabelConfiguratorRpc,
  HomeAssistantLabelConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.labelId === "string" && values.labelId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.labelId);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-homeassistant.label-configurator-ui.label")} description={t("gatekeeper-homeassistant.label-configurator-ui.choose_a_home_assistant_label_the_binding_grants_access_to_every")}>
        <Autocomplete
          name="labelId"
          value={values.labelId}
          placeholder={t("gatekeeper-homeassistant.label-configurator-ui.search_labels")}
          loadOptions={query => ui.listLabels(query)}
          onChange={labelId => setValues({ labelId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantLabelConfiguratorRpc, HomeAssistantLabelConfiguratorValues>;
