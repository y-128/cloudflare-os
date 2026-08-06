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
      <Field label="デバイス" description="物理デバイスを選択します。バインディングにより、デバイスが提供するすべてのエンティティへのアクセスが許可されます。">
        <Autocomplete
          name="deviceId"
          value={values.deviceId}
          placeholder="デバイスを検索…"
          loadOptions={query => ui.listDevices(query)}
          onChange={deviceId => setValues({ deviceId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantDeviceConfiguratorRpc, HomeAssistantDeviceConfiguratorValues>;
