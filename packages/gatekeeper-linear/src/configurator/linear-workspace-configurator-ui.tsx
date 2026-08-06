import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  LinearWorkspaceConfiguratorRpc,
  LinearWorkspaceConfiguratorValues,
} from "./linear-workspace-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.workspaceUrlKey === "string" && values.workspaceUrlKey.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [workspaceUrlKey] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    return workspaceUrlKey ? { workspaceUrlKey } : {};
  },

  resourceUrl({ values }) {
    return `https://linear.app/${values.workspaceUrlKey}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="ワークスペース" description="このアカウントが接続されているリニア ワークスペース。">
        <Autocomplete
          name="workspaceUrlKey"
          value={values.workspaceUrlKey}
          placeholder="ワークスペースを選択…"
          loadOptions={() => ui.listWorkspaces()}
          onChange={workspaceUrlKey => setValues({ workspaceUrlKey })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<LinearWorkspaceConfiguratorRpc, LinearWorkspaceConfiguratorValues>;
