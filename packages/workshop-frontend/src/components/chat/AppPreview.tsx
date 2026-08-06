import { Badge } from '@cloudflare/kumo'
import { Text } from '@cloudflare/kumo'
import { Circle } from '@phosphor-icons/react'
import { sampleDataRows } from '../../data/chat'

/**
 * App tab = live preview of the running app.
 * This renders a mock of what the deployed Slack summarizer looks like.
 */
export default function AppPreview() {
  return (
    <div className="flex flex-col h-full bg-kumo-base">
      {/* App content */}
      <div className="flex-1 overflow-auto p-6">
        {/* App header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <Text variant="heading2" as="h1">チャネルサマライザー</Text>
            <p className="text-sm text-kumo-subtle mt-1">
              Workers AI を活用した Slack チャンネルの日次ダイジェスト
            </p>
          </div>
          <Badge variant="success">ライブ</Badge>
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
                  <Badge variant="primary">{row.messages} メッセージ</Badge>
                </div>
                <span className="text-xs text-kumo-subtle">{row.lastActive}</span>
              </div>
              {/* Fake summary */}
              <div className="space-y-1.5 mt-3">
                <div className="flex items-start gap-2">
                  <Circle size={5} className="text-kumo-subtle mt-1.5 flex-shrink-0" weight="fill" />
                  <p className="text-sm text-kumo-subtle">
                    {row.channel === '#general'
                      ? 'チームで第1四半期の計画日程を話し合い、提案期限を3月15日に決定'
                      : row.channel === '#engineering'
                        ? '認証タイムアウトの修正を含むv2.4.1をデプロイ。監視ダッシュボードでは遅延が正常値に復帰'
                        : '週末のハッカソン企画と金曜日のランチについて活発に議論中'}
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <Circle size={5} className="text-kumo-subtle mt-1.5 flex-shrink-0" weight="fill" />
                  <p className="text-sm text-kumo-subtle">
                    {row.channel === '#general'
                      ? 'アクション項目3件を割り当て、2件を決定'
                      : row.channel === '#engineering'
                        ? '新しいキャッシュ層のRFCが5件の承認を得て実装へ移行'
                        : '参加者12人、話題: ハッカソン、チームランチ、オフサイト'}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Quiet channels */}
        <div className="mt-6">
          <div className="text-xs font-semibold text-kumo-subtle uppercase tracking-wider mb-3">
            新しい活動はありません
          </div>
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
