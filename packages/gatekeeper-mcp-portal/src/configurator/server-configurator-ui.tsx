import {
  Autocomplete, CheckboxList, Field, h, RadioCards, Section,
  type ConfiguratorUIOption, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  McpServerConfiguratorRpc,
  McpServerConfiguratorValues,
} from "./server-configurator-types";

let pendingServers: Promise<ConfiguratorUIOption[]> | null = null;
let loadedServers: ConfiguratorUIOption[] | null = null;

function serverOptions(ui: McpServerConfiguratorRpc): Promise<ConfiguratorUIOption[]> {
  pendingServers ??= (async () => {
    loadedServers = await ui.listServerOptions();
    return loadedServers;
  })();
  return pendingServers;
}

async function loadServerOptions(
  ui: McpServerConfiguratorRpc,
  query = "",
): Promise<ConfiguratorUIOption[]> {
  const servers = await serverOptions(ui);
  const needle = query.trim().toLowerCase();
  return needle
    ? servers.filter(server =>
        server.value.toLowerCase().includes(needle) || server.title.toLowerCase().includes(needle))
    : servers;
}

export default {
  initial: { server: null, mode: "all", tools: null, endpointKind: "unknown" },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const params = new URLSearchParams(new URL(resourceUrl).hash.slice(1));
    const selected = params.getAll("tool").map(name => name.trim()).filter(Boolean)
      .map(encodeURIComponent);
    const server = params.get("server")?.trim() || null;
    return {
      server,
      mode: params.has("tool") ? "choose" : "all",
      tools: selected.length > 0 ? selected.join(",") : null,
      endpointKind: server ? "portal" : "unknown",
    };
  },

  isReady({ values }) {
    if (values.endpointKind === "unavailable" || !values.server) return false;
    return values.mode === "all"
      || (values.tools ?? "").split(",").some(name => name.trim().length > 0);
  },

  async resourceUrl({ values, ui }) {
    if (!values.server) throw new Error("Choose a server behind this portal before adding it.");
    const endpoint = await ui.getEndpoint();
    const params = new URLSearchParams({ server: values.server });
    if (values.mode !== "all") {
      const selected = (values.tools ?? "").split(",").map(name => name.trim()).filter(Boolean)
        .map(decodeURIComponent);
      for (const tool of selected) params.append("tool", tool);
      if (selected.length === 0) params.append("tool", "");
    }
    return `${endpoint}#${params}`;
  },

  render({ values, setValues, ui }) {
    if (values.endpointKind === "unknown") {
      void serverOptions(ui).then(
        servers => setValues({
          endpointKind: "portal",
          server: servers.length === 1 ? servers[0].value : values.server,
        }),
        () => setValues({ endpointKind: "unavailable" }),
      );
    }

    if (values.endpointKind === "unavailable") {
      return <Section>
        <Field
          label="サーバ"
          description={
            "ポータルにアクセスして背後のサーバーを一覧表示できなかったため、何もすることができません" +
            "付与はまだです。これを閉じて、もう一度試してください。引き続き発生する場合は、管理者に問い合わせてください。" +
            "ポータルの設定を確認してください。"
          }
        />
      </Section>;
    }

    const soleServer = loadedServers?.length === 1 ? loadedServers[0] : null;
    const mode = values.mode === "choose" ? "choose" : "all";
    const toolsReady = Boolean(values.server);
    const serverKey = values.server ?? "";
    const selectedCount = (values.tools ?? "").split(",").filter(Boolean).length;

    return <Section>
      {!soleServer && <Field
        label="サーバ"
        description="このポータルの背後にあるどのサーバーに許可を与えるか。次にそのツールが表示されます。"
      >
        <Autocomplete
          name="server"
          value={values.server}
          placeholder="このポータル配下のサーバーを検索…"
          loadOptions={query => loadServerOptions(ui, query)}
          onChange={server => setValues({ server, tools: null })}
          onClear={() => setValues({ server: null, tools: null })}
        />
      </Field>}

      {toolsReady && <Field
        label={soleServer ? `Tools · ${soleServer.title}` : "ツール"}
        description="この接続が呼び出すサーバーの量を選択します。"
      >
        <RadioCards
          value={mode}
          options={[
            {
              value: "all",
              title: "All tools",
              description: "Every tool this server offers, including ones it adds later.",
            },
            {
              value: "choose",
              title: "Choose tools",
              description:
                "Only the tools you tick. Anything else is refused, including tools added later.",
            },
          ]}
          onChange={next => setValues({ mode: next })}
        />
      </Field>}

      {toolsReady && <Field
        label="許可されたツール"
        description={mode === "all"
          ? "読み取り専用ツールはデータをすぐに返します。残りのキューはあなたの承認を待ちます。"
          : selectedCount > 0
            ? `${selectedCount} selected. Read-only tools return data straight away; the rest `
              + "あなたの承認を待ちます。"
            : "何かを許可するには、少なくとも 1 つのツールにチェックを入れます。"}
      >
        <CheckboxList
          name={`tools:${serverKey}`}
          value={values.tools}
          loadOptions={async () => (await ui.listToolOptions(values.server ?? undefined))
            .map(option => ({ ...option, value: encodeURIComponent(option.value) }))}
          allSelected={mode === "all"}
          disabled={mode === "all"}
          onChange={tools => setValues({ tools })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<McpServerConfiguratorRpc, McpServerConfiguratorValues>;
