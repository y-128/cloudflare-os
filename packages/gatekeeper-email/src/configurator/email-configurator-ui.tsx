import { t } from "@gadgets/configurator-ui";
import { Field, h, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { EmailMailboxConfiguratorRpc, EmailMailboxConfiguratorValues } from "./email-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.emailName === "string" && values.emailName.trim().length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const user = segments[segments.length - 1];
    return user ? { emailName: decodeURIComponent(user) } : {};
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.emailName);
  },

  render({ values, setValues }) {
    return <Section>
      <Field label={t("gatekeeper-email.email-configurator-ui.email_name")} description={t("gatekeeper-email.email-configurator-ui.choose_the_local_part_of_the_mailbox_address_this_connection_can")}>
        <TextInput
          name="emailName"
          value={values.emailName}
          placeholder={t("gatekeeper-email.email-configurator-ui.alerts")}
          onChange={emailName => setValues({ emailName })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<EmailMailboxConfiguratorRpc, EmailMailboxConfiguratorValues>;
