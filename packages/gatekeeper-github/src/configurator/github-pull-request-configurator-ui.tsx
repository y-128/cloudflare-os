import { t } from "@gadgets/configurator-ui";
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
      <Field label={t("gatekeeper-github.github-pull-request-configurator-ui.repository")} description={t("gatekeeper-github.github-pull-request-configurator-ui.search_your_repositories_or_enter_a_github_url")}>
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder={t("gatekeeper-github.github-pull-request-configurator-ui.search_or_paste_a_repository_url")}
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName, pullNumber: null })}
        />
      </Field>

      <Field label={t("gatekeeper-github.github-pull-request-configurator-ui.pull_request")} description={t("gatekeeper-github.github-pull-request-configurator-ui.choose_a_pull_request_in_the_selected_repository")}>
        <Autocomplete
          name="pullNumber"
          value={values.pullNumber}
          placeholder={values.repoFullName ? t("gatekeeper-github.github-pull-request-configurator-ui.search_pull_requests") : t("gatekeeper-github.github-pull-request-configurator-ui.choose_a_repository_first")}
          disabled={!values.repoFullName}
          loadOptions={query => ui.listPullRequests(values.repoFullName, query)}
          onChange={pullNumber => setValues({ pullNumber })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubPullRequestConfiguratorRpc, GitHubPullRequestConfiguratorValues>;
