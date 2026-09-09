import { t } from "@gadgets/configurator-ui";
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
      <Field label={t("gatekeeper-github.github-repo-configurator-ui.repository")} description={t("gatekeeper-github.github-repo-configurator-ui.search_your_repositories_or_enter_a_github_url")}>
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder={t("gatekeeper-github.github-repo-configurator-ui.search_or_paste_a_repository_url")}
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubRepoConfiguratorRpc, GitHubRepoConfiguratorValues>;
