import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantEntityConfiguratorRpc,
  HomeAssistantEntityConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.entityId === "string" && values.entityId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.entityId);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-homeassistant.entity-configurator-ui.entity")} description={t("gatekeeper-homeassistant.entity-configurator-ui.choose_a_single_home_assistant_entity_light_sensor_switch_etc")}>
        <Autocomplete
          name="entityId"
          value={values.entityId}
          placeholder={t("gatekeeper-homeassistant.entity-configurator-ui.search_entities")}
          loadOptions={query => ui.listEntities(query)}
          onChange={entityId => setValues({ entityId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantEntityConfiguratorRpc, HomeAssistantEntityConfiguratorValues>;
