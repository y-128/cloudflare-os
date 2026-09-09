import { t } from "@gadgets/configurator-ui";
import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ZoomInfoAccountConfiguratorRpc,
  ZoomInfoAccountConfiguratorValues,
} from "./account-configurator-types";

// The whole-account resource has no user-selectable inputs — once an account is connected, the
// resource URL is fully determined. The configurator confirms which account is being connected and
// signals readiness. The sandboxed runtime has no effect hooks, so we render static text and rely
// on `resourceUrl` (via the `ui` capability) to produce the canonical URL.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label={t("gatekeeper-zoominfo.account-configurator-ui.whole_account_access")}
        description={t("gatekeeper-zoominfo.account-configurator-ui.this_binding_grants_access_to_the_connected_zoominfo_account_loo")}>
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ZoomInfoAccountConfiguratorRpc, ZoomInfoAccountConfiguratorValues>;
