import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  SupabaseProjectConfiguratorRpc,
  SupabaseProjectConfiguratorValues,
} from "./supabase-project-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.ref === "string" && values.ref.length > 0;
  },

  resourceUrl({ values }) {
    return `https://supabase.com/dashboard/project/${values.ref}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-supabase.supabase-project-configurator-ui.project")} description={t("gatekeeper-supabase.supabase-project-configurator-ui.search_the_projects_in_your_connected_supabase_account")}>
        <Autocomplete
          name="ref"
          value={values.ref}
          placeholder={t("gatekeeper-supabase.supabase-project-configurator-ui.search_projects")}
          loadOptions={query => ui.listProjects(query)}
          onChange={ref => setValues({ ref })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SupabaseProjectConfiguratorRpc, SupabaseProjectConfiguratorValues>;
