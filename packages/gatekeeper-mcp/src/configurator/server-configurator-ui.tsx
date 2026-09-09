import { t } from "@gadgets/configurator-ui";
import {
  CheckboxList, Field, h, RadioCards, Section, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  McpServerConfiguratorRpc,
  McpServerConfiguratorValues,
} from "./server-configurator-types";

export default {
  initial: { mode: "all", tools: null },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const params = new URLSearchParams(new URL(resourceUrl).hash.slice(1));
    const selected = params.getAll("tool").map(name => name.trim()).filter(Boolean)
      .map(encodeURIComponent);
    return {
      mode: params.has("tool") ? "choose" : "all",
      tools: selected.length > 0 ? selected.join(",") : null,
    };
  },

  isReady({ values }) {
    return values.mode === "all"
      || (values.tools ?? "").split(",").some(name => name.trim().length > 0);
  },

  async resourceUrl({ values, ui }) {
    const endpoint = await ui.getEndpoint();
    if (values.mode === "all") return endpoint;

    const params = new URLSearchParams();
    const selected = (values.tools ?? "").split(",").map(name => name.trim()).filter(Boolean)
      .map(decodeURIComponent);
    for (const tool of selected) params.append("tool", tool);
    if (selected.length === 0) params.append("tool", "");
    return `${endpoint}#${params}`;
  },

  render({ values, setValues, ui }) {
    const mode = values.mode === "choose" ? "choose" : "all";
    const selectedCount = (values.tools ?? "").split(",").filter(Boolean).length;

    return <Section>
      <Field label={t("gatekeeper-mcp.server-configurator-ui.tools")} description={t("gatekeeper-mcp.server-configurator-ui.choose_how_much_of_this_server_this_connection_may_call")}>
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
                t("gatekeeper-mcp.server-configurator-ui.only_the_tools_you_tick_anything_else_is_refused_including_tools_"),
            },
          ]}
          onChange={next => setValues({ mode: next })}
        />
      </Field>
      <Field
        label={t("gatekeeper-mcp.server-configurator-ui.allowed_tools")}
        description={mode === "all"
          ? t("gatekeeper-mcp.server-configurator-ui.read_only_tools_return_data_straight_away_the_rest_queue_for_you")
          : selectedCount > 0
            ? t("gatekeeper-mcp.server-configurator-ui.selected_read_only_tools_return_data_straight_away_the_rest_queue", { n: selectedCount })
            : t("gatekeeper-mcp.server-configurator-ui.tick_at_least_one_tool_to_grant_anything")}>
        <CheckboxList
          name="tools"
          value={values.tools}
          loadOptions={async () => (await ui.listToolOptions())
            .map(option => ({ ...option, value: encodeURIComponent(option.value) }))}
          allSelected={mode === "all"}
          disabled={mode === "all"}
          onChange={tools => setValues({ tools })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<McpServerConfiguratorRpc, McpServerConfiguratorValues>;
