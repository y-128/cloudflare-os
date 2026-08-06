import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ConversationConfiguratorRpc, ConversationConfiguratorValues,
} from "./conversation-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.conversationId === "string" && values.conversationId.length > 0;
  },

  async resourceUrl({ values, ui }) {
    const teamId = await ui.getTeamId();
    return `https://app.slack.com/client/${teamId}/${encodeURIComponent(values.conversationId ?? "")}`;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const conversationId = segments[2];
    return conversationId ? { conversationId: decodeURIComponent(conversationId) } : {};
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="会話"
        description="この接続で読み取ることができるチャネルまたはダイレクト メッセージを選択します。"
      >
        <Autocomplete
          name="conversationId"
          value={values.conversationId}
          placeholder="チャンネルとDMを検索…"
          loadOptions={query => ui.listConversations(query)}
          onChange={conversationId => setValues({ conversationId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ConversationConfiguratorRpc, ConversationConfiguratorValues>;
