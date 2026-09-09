import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantAreaConfiguratorRpc,
  HomeAssistantAreaConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.areaId === "string" && values.areaId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.areaId);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-homeassistant.area-configurator-ui.area")} description={t("gatekeeper-homeassistant.area-configurator-ui.choose_a_home_assistant_area_room")}>
        <Autocomplete
          name="areaId"
          value={values.areaId}
          placeholder={t("gatekeeper-homeassistant.area-configurator-ui.search_areas")}
          loadOptions={query => ui.listAreas(query)}
          onChange={areaId => setValues({ areaId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantAreaConfiguratorRpc, HomeAssistantAreaConfiguratorValues>;
