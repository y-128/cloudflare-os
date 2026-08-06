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
      <Field label="ラベル" description="ホーム アシスタントのラベルを選択します。バインディングは、このラベルを持つすべてのエンティティへのアクセスを許可します。">
        <Autocomplete
          name="labelId"
          value={values.labelId}
          placeholder="ラベルを検索…"
          loadOptions={query => ui.listLabels(query)}
          onChange={labelId => setValues({ labelId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<HomeAssistantLabelConfiguratorRpc, HomeAssistantLabelConfiguratorValues>;
