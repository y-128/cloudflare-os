import { t } from "@gadgets/configurator-ui";
import { Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { DriveAccountConfiguratorRpc, DriveAccountConfiguratorValues } from "./drive-account-configurator-types";

export default {
  initial: { scope: "account" },
  isReady: () => true,
  // Must mirror `parseDriveUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: () => "https://drive.google.com/drive/my-drive",
  render({ setValues }) {
    return <Section>
      <Field
        label={t("gatekeeper-google.drive-account-configurator-ui.google_drive_account")}
        description={t("gatekeeper-google.drive-account-configurator-ui.find_files_and_folders_anywhere_this_google_account_can_read_in_d")}
      >
        <RadioCards
          value="account"
          options={[{
            value: "account", title: t("gatekeeper-google.drive-account-configurator-ui.everything_this_account_can_read_in_drive"),
            description: t("gatekeeper-google.drive-account-configurator-ui.includes_direct_lookup_by_file_id_search_results_contain_metadata"),
          }]}
          onChange={() => setValues({ scope: "account" })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveAccountConfiguratorRpc, DriveAccountConfiguratorValues>;
