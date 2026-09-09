import { t } from "@gadgets/configurator-ui";
import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  NotionWorkspaceConfiguratorRpc,
  NotionWorkspaceConfiguratorValues,
} from "./notion-workspace-configurator-types";

export default {
  initial: {},

  // Whole-workspace access takes no parameters, so it is always ready to add.
  isReady() {
    return true;
  },

  resourceUrl() {
    return "https://www.notion.so/";
  },

  render() {
    return <Section>
      <Field
        label={t("gatekeeper-notion.notion-workspace-configurator-ui.whole_workspace")}
        description={t("gatekeeper-notion.notion-workspace-configurator-ui.grants_access_to_every_page_and_database_you_have_shared_with_th")}
      >
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NotionWorkspaceConfiguratorRpc, NotionWorkspaceConfiguratorValues>;
