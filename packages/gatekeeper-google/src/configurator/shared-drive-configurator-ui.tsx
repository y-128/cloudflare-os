import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { SharedDriveConfiguratorRpc, SharedDriveConfiguratorValues } from "./shared-drive-configurator-types";

export default {
  initial: {},
  isReady: ({ values }) => typeof values.driveId === "string" && values.driveId.length > 0,
  // Must mirror `parseDriveUrl` in resources.ts, which is what actually mints the capability. This
  // module is transpiled on its own and cannot import that parser, so `__tests__/configurator-url
  // .test.ts` is what keeps the copies honest.
  resourceUrl: ({ values }) =>
    `https://drive.google.com/drive/folders/${encodeURIComponent(values.driveId ?? "")}`,
  render({ values, setValues, ui }) {
    return <Section>
      <Field label={t("gatekeeper-google.shared-drive-configurator-ui.google_workspace_shared_drive")} description={t("gatekeeper-google.shared-drive-configurator-ui.choose_a_shared_drive_owned_by_an_organization_rather_than_an_ind")}>
        <Autocomplete
          name="driveId"
          value={values.driveId}
          placeholder={t("gatekeeper-google.shared-drive-configurator-ui.search_shared_drives")}
          loadOptions={query => ui.listSharedDrives(query)}
          onChange={driveId => setValues({ driveId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SharedDriveConfiguratorRpc, SharedDriveConfiguratorValues>;
