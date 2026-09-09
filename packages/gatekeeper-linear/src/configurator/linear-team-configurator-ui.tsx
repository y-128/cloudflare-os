import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  LinearTeamConfiguratorRpc,
  LinearTeamConfiguratorValues,
} from "./linear-team-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.teamKey === "string" && values.teamKey.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const teamIndex = segments.indexOf("team");
    const teamKey = teamIndex >= 0 ? segments[teamIndex + 1] : undefined;
    return teamKey ? { teamKey } : {};
  },

  async resourceUrl({ values, ui }) {
    const workspaceUrlKey = await ui.getWorkspaceUrlKey();
    return `https://linear.app/${workspaceUrlKey}/team/${values.teamKey}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-linear.linear-team-configurator-ui.team")} description={t("gatekeeper-linear.linear-team-configurator-ui.search_the_teams_in_your_workspace")}>
        <Autocomplete
          name="teamKey"
          value={values.teamKey}
          placeholder={t("gatekeeper-linear.linear-team-configurator-ui.search_teams")}
          loadOptions={query => ui.listTeams(query)}
          onChange={teamKey => setValues({ teamKey })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<LinearTeamConfiguratorRpc, LinearTeamConfiguratorValues>;
