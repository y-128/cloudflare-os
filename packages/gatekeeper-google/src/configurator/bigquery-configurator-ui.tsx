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
      <Field label="プロジェクト" description="この接続でクエリできる Google Cloud プロジェクトから始めます。">
        <Autocomplete
          name="projectId"
          value={values.projectId}
          placeholder="プロジェクトを検索…"
          loadOptions={query => ui.listProjects(query)}
          onChange={projectId => {
            clearFields("datasetId", "tableId");
            setValues({ projectId, datasetId: null, tableId: null });
          }}
        />
      </Field>

      <Field label="データセット" description="プロジェクト内のすべてのデータセットを許可するには、空白のままにします。" optional>
        <Autocomplete
          name="datasetId"
          value={values.datasetId}
          placeholder={values.projectId ? "データセットを検索..." : "最初にプロジェクトを選択してください"}
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

      <Field label="テーブル" description="データセット内のすべてのテーブルを許可するには、空白のままにします。" optional>
        <Autocomplete
          name="tableId"
          value={values.tableId}
          placeholder={values.datasetId ? "テーブルを検索..." : "最初にデータセットを選択してください"}
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
