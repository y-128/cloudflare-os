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
      <Field label="エリア" description="ホーム アシスタント エリア (部屋) を選択します。">
        <Autocomplete
          name="areaId"
          value={values.areaId}
          placeholder="エリアを検索…"
          loadOptions={query => ui.listAreas(query)}
          onChange={areaId => setValues({ areaId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantAreaConfiguratorRpc, HomeAssistantAreaConfiguratorValues>;
