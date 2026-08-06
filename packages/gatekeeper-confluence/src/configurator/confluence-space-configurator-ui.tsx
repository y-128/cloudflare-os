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
      <Field label="空間" description="この接続で共有されているスペースを検索します。">
        <Autocomplete
          name="spaceUrl"
          value={values.spaceUrl}
          placeholder="スペースを検索…"
          loadOptions={query => ui.listSpaces(query)}
          onChange={spaceUrl => setValues({ spaceUrl })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConfluenceSpaceConfiguratorRpc, ConfluenceSpaceConfiguratorValues>;
