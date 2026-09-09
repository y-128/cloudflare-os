import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  HomeAssistantDeviceConfiguratorRpc,
  HomeAssistantDeviceConfiguratorValues,
} from "./resource-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.deviceId === "string" && values.deviceId.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.deviceId);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-homeassistant.device-configurator-ui.device")} description={t("gatekeeper-homeassistant.device-configurator-ui.choose_a_physical_device_the_binding_grants_access_to_all_entiti")}>
        <Autocomplete
          name="deviceId"
          value={values.deviceId}
          placeholder={t("gatekeeper-homeassistant.device-configurator-ui.search_devices")}
          loadOptions={query => ui.listDevices(query)}
          onChange={deviceId => setValues({ deviceId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantDeviceConfiguratorRpc, HomeAssistantDeviceConfiguratorValues>;
