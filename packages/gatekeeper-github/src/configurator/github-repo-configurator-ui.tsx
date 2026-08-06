import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues } from "./github-repo-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.repoFullName === "string" && values.repoFullName.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [owner, repo] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    return owner && repo ? { repoFullName: `${owner}/${repo}` } : {};
  },

  resourceUrl({ values }) {
    return `https://github.com/${values.repoFullName}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="リポジトリ" description="リポジトリを検索するか、GitHub URL を入力します。">
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder="リポジトリURLを検索または貼り付け…"
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues>;
