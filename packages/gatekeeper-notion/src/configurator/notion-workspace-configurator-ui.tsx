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
        label="ワークスペース全体"
        description="この Notion 接続で共有したすべてのページとデータベースへのアクセスを許可します。アクセスを制限するには、代わりに単一のページまたはデータベースに接続します。"
      >
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<NotionWorkspaceConfiguratorRpc, NotionWorkspaceConfiguratorValues>;
