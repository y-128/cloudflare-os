import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubPullRequestConfiguratorRpc, GitHubPullRequestConfiguratorValues } from "./github-pull-request-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0 &&
      typeof values.pullNumber === "string" && values.pullNumber.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo, , number] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    if (!owner || !repo) return {};
    return { repoFullName: `${owner}/${repo}`, pullNumber: number ?? null };
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}/pull/${values.pullNumber}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="リポジトリ" description="リポジトリを検索するか、GitHub URL を入力します。">
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder="リポジトリURLを検索または貼り付け…"
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName, pullNumber: null })}
        />
      </Field>

      <Field label="プルリクエスト" description="選択したリポジトリでプル リクエストを選択します。">
        <Autocomplete
          name="pullNumber"
          value={values.pullNumber}
          placeholder={values.repoFullName ? "プル リクエストを検索..." : "最初にリポジトリを選択します"}
          disabled={!values.repoFullName}
          loadOptions={query => ui.listPullRequests(values.repoFullName, query)}
          onChange={pullNumber => setValues({ pullNumber })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubPullRequestConfiguratorRpc, GitHubPullRequestConfiguratorValues>;
