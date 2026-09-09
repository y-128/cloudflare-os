import { t } from "@gadgets/configurator-ui";
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
      <Field label={t("gatekeeper-linear.linear-workspace-configurator-ui.workspace")} description={t("gatekeeper-linear.linear-workspace-configurator-ui.the_linear_workspace_this_account_is_connected_to")}>
        <Autocomplete
          name="workspaceUrlKey"
          value={values.workspaceUrlKey}
          placeholder={t("gatekeeper-linear.linear-workspace-configurator-ui.select_your_workspace")}
          loadOptions={() => ui.listWorkspaces()}
          onChange={workspaceUrlKey => setValues({ workspaceUrlKey })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<LinearWorkspaceConfiguratorRpc, LinearWorkspaceConfiguratorValues>;
