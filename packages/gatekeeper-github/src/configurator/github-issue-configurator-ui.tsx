import { t } from "@gadgets/configurator-ui";
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
      <Field label={t("gatekeeper-github.github-issue-configurator-ui.repository")} description={t("gatekeeper-github.github-issue-configurator-ui.search_your_repositories_or_enter_a_github_url")}>
        <Autocomplete
          name="repoFullName"
          value={values.repoFullName}
          placeholder={t("gatekeeper-github.github-issue-configurator-ui.search_or_paste_a_repository_url")}
          loadOptions={query => ui.listRepos(query)}
          onChange={repoFullName => setValues({ repoFullName, issueNumber: null })}
        />
      </Field>

      <Field label={t("gatekeeper-github.github-issue-configurator-ui.issue")} description={t("gatekeeper-github.github-issue-configurator-ui.choose_an_issue_in_the_selected_repository")}>
        <Autocomplete
          name="issueNumber"
          value={values.issueNumber}
          placeholder={values.repoFullName ? t("gatekeeper-github.github-issue-configurator-ui.search_issues") : t("gatekeeper-github.github-issue-configurator-ui.choose_a_repository_first")}
          disabled={!values.repoFullName}
          loadOptions={query => ui.listIssues(values.repoFullName, query)}
          onChange={issueNumber => setValues({ issueNumber })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubIssueConfiguratorRpc, GitHubIssueConfiguratorValues>;
