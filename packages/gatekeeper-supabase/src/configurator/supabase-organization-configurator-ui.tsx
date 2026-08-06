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
      <Field label="組織" description="接続されている Supabase アカウント内の組織を検索します。">
        <Autocomplete
          name="slug"
          value={values.slug}
          placeholder="組織を検索…"
          loadOptions={query => ui.listOrganizations(query)}
          onChange={slug => setValues({ slug })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SupabaseOrganizationConfiguratorRpc, SupabaseOrganizationConfiguratorValues>;
