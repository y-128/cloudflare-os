import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  CloudflareAccountConfiguratorValues,
  CloudflareAccountConfiguratorRpc,
} from "./cloudflare-configurator-types";

export default {
  initial: { accountId: null },

  isReady({ values }) {
    return !!values.accountId;
  },

  resourceUrl({ values }) {
    return `https://dash.cloudflare.com/${encodeURIComponent(values.accountId!)}/workers-and-pages/observability`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("workshop-frontend.AccountSelectionModal.cloudflare_account")} description={t("gatekeeper-cloudflare.cloudflare-account-configurator-ui.queries_telemetry_across_every_worker_in_this_account")}>
        <Autocomplete
          name="accountId"
          value={values.accountId}
          placeholder={t("gatekeeper-cloudflare.cloudflare-account-configurator-ui.choose_an_account")}
          loadOptions={query => ui.listAccounts(query)}
          onChange={accountId => setValues({ accountId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CloudflareAccountConfiguratorRpc, CloudflareAccountConfiguratorValues>;
