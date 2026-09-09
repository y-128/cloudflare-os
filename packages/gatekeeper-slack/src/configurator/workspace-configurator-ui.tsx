import { t } from "@gadgets/configurator-ui";
import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues,
} from "./workspace-configurator-types";

export default {
  initial: {},

  isReady() {
    return true;
  },

  async resourceUrl({ ui }) {
    return await ui.getWorkspaceUrl();
  },

  render() {
    return <Section>
      <Field
        label={t("gatekeeper-slack.workspace-configurator-ui.whole_workspace")}
        description={t("gatekeeper-slack.workspace-configurator-ui.this_connection_lets_the_client_read_the_channels_and_direct_mes")}
      >
        <span />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues>;
