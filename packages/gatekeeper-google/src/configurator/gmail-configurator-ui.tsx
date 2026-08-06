import { Field, h, RadioCards, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GmailConfiguratorRpc, GmailConfiguratorValues } from "./gmail-configurator-types";

export default {
  initial: { mode: "all" },

  isReady({ values }) {
    const mode = values.mode ?? "all";
    if (mode === "all") return true;
    if (mode === "search") return typeof values.query === "string" && values.query.trim().length > 0;
    if (mode === "label") return typeof values.label === "string" && values.label.trim().length > 0;
    return false;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const hash = new URL(resourceUrl).hash.replace(/^#/, "");
    if (hash.startsWith("search/")) {
      return { mode: "search", query: decodeURIComponent(hash.slice("search/".length)) };
    }
    if (hash.startsWith("label/")) {
      return { mode: "label", label: decodeURIComponent(hash.slice("label/".length)) };
    }
    return { mode: "all" };
  },

  resourceUrl({ values }) {
    const mode = values.mode ?? "all";
    if (mode === "search") {
      return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(values.query ?? "")}`;
    }
    if (mode === "label") {
      return `https://mail.google.com/mail/u/0/#label/${encodeURIComponent(values.label ?? "")}`;
    }
    return "https://mail.google.com/mail/u/0/";
  },

  render({ values, setValues, clearFields }) {
    const mode = values.mode ?? "all";
    return <Section>
      <Field label="メールボックスのスコープ" description="この接続ですべての Gmail メッセージにアクセスできるか、それとも狭いネイティブ Gmail ビューにアクセスできるかを選択します。">
        <RadioCards
          value={mode}
          options={[
            { value: "all", title: "All Gmail", description: "Allow access to the whole mailbox." },
            { value: "search", title: "検索", description: "Allow messages matching a Gmail search query." },
            { value: "label", title: "Label", description: "Allow messages with a specific Gmail label." },
          ]}
          onChange={nextMode => {
            if (nextMode !== "all" && nextMode !== "search" && nextMode !== "label") return;
            clearFields("query", "label");
            setValues({ mode: nextMode, query: null, label: null });
          }}
        />
      </Field>

      {mode === "search" && <Field label="検索クエリ" description="Gmail 検索と同じクエリ構文を使用します。">
        <TextInput
          name="query"
          value={values.query}
          placeholder="from:alerts@example.com 新しい_than:30d"
          onChange={query => setValues({ query })}
        />
      </Field>}

      {mode === "label" && <Field label="ラベル" description="Gmail に表示される Gmail ラベル名を正確に使用してください。">
        <TextInput
          name="label"
          value={values.label}
          placeholder="領収書"
          onChange={label => setValues({ label })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<GmailConfiguratorRpc, GmailConfiguratorValues>;
