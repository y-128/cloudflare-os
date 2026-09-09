import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  SupabaseOrganizationConfiguratorRpc,
  SupabaseOrganizationConfiguratorValues,
} from "./supabase-organization-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.slug === "string" && values.slug.length > 0;
  },

  resourceUrl({ values }) {
    return `https://supabase.com/dashboard/org/${values.slug}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-supabase.supabase-organization-configurator-ui.organization")} description={t("gatekeeper-supabase.supabase-organization-configurator-ui.search_the_organizations_in_your_connected_supabase_account")}>
        <Autocomplete
          name="slug"
          value={values.slug}
          placeholder={t("gatekeeper-supabase.supabase-organization-configurator-ui.search_organizations")}
          loadOptions={query => ui.listOrganizations(query)}
          onChange={slug => setValues({ slug })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SupabaseOrganizationConfiguratorRpc, SupabaseOrganizationConfiguratorValues>;
