import { useTranslation, renderTranslation } from "@gadgets/i18n";
import { Badge } from '@cloudflare/kumo'
import { Text } from '@cloudflare/kumo'
import { Circle } from '@phosphor-icons/react'
import { sampleDataRows } from '../../data/chat'

/**
 * App tab = live preview of the running app.
 * This renders a mock of what the deployed Slack summarizer looks like.
 */
export default function AppPreview() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col h-full bg-kumo-base">
      {/* App content */}
      <div className="flex-1 overflow-auto p-6">
        {/* App header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <Text variant="heading2" as="h1">{t("workshop-frontend.AppPreview.channel_summarizer")}</Text>
            <p className="text-sm text-kumo-subtle mt-1">
              {t("workshop-frontend.AppPreview.daily_digest_of_your_slack_channels_powered_by_workers_ai")}</p>
          </div>
          <Badge variant="success">{t("workshop-frontend.AppPreview.live")}</Badge>
        </div>

        {/* Channel cards */}
        <div className="grid gap-3">
          {sampleDataRows.filter(r => r.unread).map((row) => (
            <div
              key={row.id}
              className="rounded-lg border border-kumo-line bg-kumo-base p-4 hover:bg-kumo-elevated transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-kumo-default">{row.channel}</span>
                  <Badge variant="primary">{renderTranslation(t("workshop-frontend.AppPreview.msgs_2"), { messages: row.messages })}</Badge>
                </div>
                <span className="text-xs text-kumo-subtle">{row.lastActive}</span>
              </div>
              {/* Fake summary */}
              <div className="space-y-1.5 mt-3">
                <div className="flex items-start gap-2">
                  <Circle size={5} className="text-kumo-subtle mt-1.5 flex-shrink-0" weight="fill" />
                  <p className="text-sm text-kumo-subtle">
                    {row.channel === '#general'
                      ? t("workshop-frontend.AppPreview.team_discussed_q1_planning_timeline_and_agreed_on_march_15_deadl")
                      : row.channel === '#engineering'
                        ? t("workshop-frontend.AppPreview.deployed_v2_4_1_hotfix_for_auth_timeout_monitoring_dashboards_sh")
                        : t("workshop-frontend.AppPreview.active_discussion_about_weekend_hackathon_projects_and_lunch_pla")}
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <Circle size={5} className="text-kumo-subtle mt-1.5 flex-shrink-0" weight="fill" />
                  <p className="text-sm text-kumo-subtle">
                    {row.channel === '#general'
                      ? t("workshop-frontend.AppPreview.3_action_items_assigned_2_decisions_made")
                      : row.channel === '#engineering'
                        ? t("workshop-frontend.AppPreview.rfc_for_new_caching_layer_received_5_approvals_moving_to_impleme")
                        : t("workshop-frontend.AppPreview.12_participants_trending_topics_hackathon_team_lunch_offsite")}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Quiet channels */}
        <div className="mt-6">
          <div className="text-xs font-semibold text-kumo-subtle uppercase tracking-wider mb-3">
            {t("workshop-frontend.AppPreview.no_new_activity")}</div>
          <div className="flex flex-wrap gap-2">
            {sampleDataRows.filter(r => !r.unread).map((row) => (
              <div key={row.id} className="px-3 py-1.5 rounded-md bg-kumo-tint">
                <span className="font-mono text-xs text-kumo-subtle">{row.channel}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
