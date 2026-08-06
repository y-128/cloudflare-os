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
        label="ワークスペース全体"
        description="この接続により、クライアントはアクセスできるチャネルとダイレクト メッセージを読み取り、Slack ワークスペース メンバーを参照し、メッセージを検索できるようになります。"
      >
        <span />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<WorkspaceConfiguratorRpc, WorkspaceConfiguratorValues>;
