import { t } from "@gadgets/configurator-ui";
import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { BigQueryConfiguratorRpc, BigQueryConfiguratorValues } from "./bigquery-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.projectId === "string" && values.projectId.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [projectId, datasetId, tableId] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const values: { projectId?: string; datasetId?: string; tableId?: string } = {};
    if (projectId) values.projectId = decodeURIComponent(projectId);
    if (datasetId) values.datasetId = decodeURIComponent(datasetId);
    if (tableId) values.tableId = decodeURIComponent(tableId);
    return values;
  },

  resourceUrl({ values }) {
    const path = [values.projectId, values.datasetId, values.tableId]
      .filter((value): value is string => !!value)
      .map(encodeURIComponent)
      .join("/");
    return `https://bigquery.googleapis.com/${path}${values.datasetId ? "" : "/"}`;
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      <Field label={t("gatekeeper-google.bigquery-configurator-ui.project")} description={t("gatekeeper-google.bigquery-configurator-ui.start_with_the_google_cloud_project_this_connection_can_query")}>
        <Autocomplete
          name="projectId"
          value={values.projectId}
          placeholder={t("gatekeeper-google.bigquery-configurator-ui.search_projects")}
          loadOptions={query => ui.listProjects(query)}
          onChange={projectId => {
            clearFields("datasetId", "tableId");
            setValues({ projectId, datasetId: null, tableId: null });
          }}
        />
      </Field>

      <Field label={t("gatekeeper-google.bigquery-configurator-ui.dataset")} description={t("gatekeeper-google.bigquery-configurator-ui.leave_blank_to_allow_all_datasets_in_the_project")} optional>
        <Autocomplete
          name="datasetId"
          value={values.datasetId}
          placeholder={values.projectId ? t("gatekeeper-google.bigquery-configurator-ui.search_datasets") : t("gatekeeper-google.bigquery-configurator-ui.choose_a_project_first")}
          disabled={!values.projectId}
          loadOptions={query => values.projectId ? ui.listDatasets(values.projectId, query) : Promise.resolve([])}
          onChange={datasetId => {
            clearFields("tableId");
            setValues({ datasetId, tableId: null });
          }}
          optional
          onClear={() => {
            clearFields("datasetId", "tableId");
            setValues({ datasetId: null, tableId: null });
          }}
        />
      </Field>

      <Field label={t("gatekeeper-google.bigquery-configurator-ui.table")} description={t("gatekeeper-google.bigquery-configurator-ui.leave_blank_to_allow_all_tables_in_dataset")} optional>
        <Autocomplete
          name="tableId"
          value={values.tableId}
          placeholder={values.datasetId ? t("gatekeeper-google.bigquery-configurator-ui.search_tables") : t("gatekeeper-google.bigquery-configurator-ui.choose_a_dataset_first")}
          disabled={!values.projectId || !values.datasetId}
          loadOptions={query => values.projectId && values.datasetId
            ? ui.listTables(values.projectId, values.datasetId, query)
            : Promise.resolve([])}
          onChange={tableId => setValues({ tableId })}
          optional
          onClear={() => {
            clearFields("tableId");
            setValues({ tableId: null });
          }}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<BigQueryConfiguratorRpc, BigQueryConfiguratorValues>;
