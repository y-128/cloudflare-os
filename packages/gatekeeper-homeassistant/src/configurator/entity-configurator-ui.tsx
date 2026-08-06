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
      <Field label="実在物" description="単一のホーム アシスタント エンティティ (ライト、センサー、スイッチなど) を選択します。">
        <Autocomplete
          name="entityId"
          value={values.entityId}
          placeholder="エンティティを検索…"
          loadOptions={query => ui.listEntities(query)}
          onChange={entityId => setValues({ entityId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantEntityConfiguratorRpc, HomeAssistantEntityConfiguratorValues>;
