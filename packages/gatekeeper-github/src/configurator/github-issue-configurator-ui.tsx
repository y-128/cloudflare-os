import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubIssueConfiguratorRpc, GitHubIssueConfiguratorValues } from "./github-issue-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0 &&
      typeof values.issueNumber === "string" && values.issueNumber.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo, , number] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    if (!owner || !repo) return {};
    return { repoFullName: `${owner}/${repo}`, issueNumber: number ?? null };
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}/issues/${values.issueNumber}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="リポジトリ" description="リポジトリを検索するか、GitHub URL を入力します。">
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder="リポジトリURLを検索または貼り付け…"
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName, issueNumber: null })}
        />
      </Field>

      <Field label="問題" description="選択したリポジトリ内の課題を選択します。">
        <Autocomplete
          name="issueNumber"
          value={values.issueNumber}
          placeholder={values.repoFullName ? "課題を検索…" : "最初にリポジトリを選択します"}
          disabled={!values.repoFullName}
          loadOptions={query => ui.listIssues(values.repoFullName, query)}
          onChange={issueNumber => setValues({ issueNumber })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubIssueConfiguratorRpc, GitHubIssueConfiguratorValues>;
