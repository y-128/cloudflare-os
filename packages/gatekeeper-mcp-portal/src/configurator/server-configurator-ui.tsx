import { t } from "@gadgets/configurator-ui";
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

  async initialValuesFromResourceUrl({ resourceUrl, ui }) {
    const params = new URLSearchParams(new URL(resourceUrl).hash.slice(1));
    const selected = params.getAll("tool").map(name => name.trim()).filter(Boolean)
      .map(encodeURIComponent);
    const requestedServer = params.get("server")?.trim() || null;
    const servers = await serverOptions(ui);
    const server = requestedServer
      ? servers.some(option => option.value === requestedServer) ? requestedServer : null
      : servers.length === 1 ? servers[0].value : null;
    return {
      server,
      mode: params.has("tool") ? "choose" : "all",
      tools: server && selected.length > 0 ? selected.join(",") : null,
      endpointKind: servers.length > 0 ? "portal" : "empty",
    };
  },

  isReady({ values }) {
    if (values.endpointKind !== "portal" || !values.server) return false;
    return values.mode === "all"
      || (values.tools ?? "").split(",").some(name => name.trim().length > 0);
  },

  async resourceUrl({ values, ui }) {
    if (!values.server) throw new Error(t("gatekeeper-mcp-portal.server-configurator-ui.choose_a_server_behind_this_portal_before_adding_it"));
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
        servers => {
          const server = values.server
            ? servers.some(option => option.value === values.server) ? values.server : null
            : servers.length === 1 ? servers[0].value : null;
          setValues({
            endpointKind: servers.length > 0 ? "portal" : "empty",
            server,
            ...(server === values.server ? {} : { tools: null }),
          });
        },
        () => setValues({ endpointKind: "unavailable" }),
      );
    }

    if (values.endpointKind === "unavailable") {
      return <Section>
        <Field
          label={t("gatekeeper-mcp-portal.server-configurator-ui.server")}
          description={
            t("gatekeeper-mcp-portal.server-configurator-ui.could_not_reach_the_portal_to_list_its_servers_close_this_and_try")
          }
        />
      </Section>;
    }

    if (values.endpointKind === "empty") {
      return <Section>
        <Field
          label={t("gatekeeper-mcp-portal.server-configurator-ui.server")}
          description={
            t("gatekeeper-mcp-portal.server-configurator-ui.no_grantable_servers_are_available_through_this_connector_they_ma")
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
      {(!soleServer || !values.server) && <Field
        label={t("gatekeeper-mcp-portal.server-configurator-ui.server")}
        description={t("gatekeeper-mcp-portal.server-configurator-ui.which_server_behind_this_portal_to_grant_its_tools_appear_next")}
      >
        <Autocomplete
          name="server"
          value={values.server}
          placeholder={t("gatekeeper-mcp-portal.server-configurator-ui.search_servers_behind_this_portal")}
          loadOptions={query => loadServerOptions(ui, query)}
          onChange={server => setValues({ server, tools: null })}
          onClear={() => setValues({ server: null, tools: null })}
        />
      </Field>}

      {toolsReady && <Field
        label={soleServer ? t("gatekeeper-mcp-portal.server-configurator-ui.tools_2", { value1: soleServer.title }) : t("gatekeeper-mcp-portal.server-configurator-ui.tools")}
        description={t("gatekeeper-mcp-portal.server-configurator-ui.choose_how_much_of_this_server_this_connection_may_call")}
      >
        <RadioCards
          value={mode}
          options={[
            {
              value: "all",
              title: t("gatekeeper-mcp-portal.server-configurator-ui.all_tools"),
              description: t("gatekeeper-mcp-portal.server-configurator-ui.every_tool_this_server_offers_including_ones_it_adds_later"),
            },
            {
              value: "choose",
              title: t("gatekeeper-mcp-portal.server-configurator-ui.choose_tools"),
              description:
                t("gatekeeper-mcp-portal.server-configurator-ui.only_the_tools_you_tick_from_up_to_200_shown_anything_else_is_ref"),
            },
          ]}
          onChange={next => setValues({ mode: next })}
        />
      </Field>}

      {toolsReady && <Field
        label={t("gatekeeper-mcp-portal.server-configurator-ui.allowed_tools")}
        description={mode === "all"
          ? t("gatekeeper-mcp-portal.server-configurator-ui.read_only_tools_return_data_straight_away_the_rest_queue_for_you")
          : selectedCount > 0
            ? t("gatekeeper-mcp.server-configurator-ui.selected_read_only_tools_return_data_straight_away_the_rest_queue", { n: selectedCount })
            : t("gatekeeper-mcp-portal.server-configurator-ui.tick_at_least_one_tool_to_grant_anything")}
      >
        <CheckboxList
          name={`tools:${serverKey}`}
          value={values.tools}
          loadOptions={async () => (await ui.listToolOptions(serverKey))
            .map(option => ({ ...option, value: encodeURIComponent(option.value) }))}
          allSelected={mode === "all"}
          disabled={mode === "all"}
          onChange={tools => setValues({ tools })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<McpServerConfiguratorRpc, McpServerConfiguratorValues>;
