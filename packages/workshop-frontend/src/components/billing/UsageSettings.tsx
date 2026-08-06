import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { Lightning, CloudCheck, Warning } from '@phosphor-icons/react'
import CloudflareLogo from '../auth/CloudflareLogo'
import { useAuthenticatedApi } from '../../AuthContext'
import { useCloudflareLimitsEnabled } from '../../ServerConfigContext'
import { buildAddCreditsUrl } from './creditsUrl'
import ResetCountdown from './ResetCountdown'

// Shows the user's free-tier usage and Cloudflare connection / credit status on the profile page.
// Renders nothing unless the Cloudflare limits flow is enabled server-side.
export default function UsageSettings() {
  const limitsEnabled = useCloudflareLimitsEnabled()
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [usage, setUsage] = useState<CloudflareUsageInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // Account-selection state (only used when the user has multiple Cloudflare accounts).
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => setUsage(u))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authenticatedApi])

  useEffect(() => {
    if (!limitsEnabled) {
      setLoading(false)
      return
    }
    refresh()
    // Re-check when the tab regains focus (e.g. after connecting / topping up elsewhere).
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [limitsEnabled, refresh])

  // When the server says the user must pick an account, load the list of accounts to choose from.
  useEffect(() => {
    if (usage?.connected && usage.needsAccountSelection && accounts === null) {
      authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => setAccounts(list))
        .catch(() => setAccounts([]))
    }
  }, [usage, accounts, authenticatedApi])

  // Hidden entirely when the feature is off, or while the unlimited (self-hosted) default applies.
  if (!limitsEnabled || (usage && usage.unlimited)) return null

  const connect = async () => {
    setBusy(true)
    try {
      // Connecting (or signing in with) Cloudflare is handled by the Cloudflare gatekeeper. Open its
      // OAuth popup; the connected-accounts subscription + focus refresh pick up the result.
      const { url } = await authenticatedApi.connectAccount('cloudflare')
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      toasts.add({ title: 'Cloudflare接続の開始に失敗しました', variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const selectAccount = async (accountId: string) => {
    setSelecting(accountId)
    try {
      await authenticatedApi.selectCloudflareAccount(accountId)
      toasts.add({ title: 'Cloudflareアカウントが選択されました', variant: 'success' })
      setAccounts(null)
      refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to select account'
      toasts.add({ title: msg, variant: 'error' })
    } finally {
      setSelecting(null)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        使用量と請求
      </h2>
      <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
      {loading || !usage ? (
        <p className="text-sm text-kumo-subtle">使用方法を読み込み中…</p>
      ) : (
        <div className="space-y-6">
          {/* Free daily allowance */}
          <div>
            <p className="text-xs font-medium text-kumo-subtle mb-1">日当無料</p>
            <p className="text-sm text-kumo-default">
              {usage.remaining} の {usage.dailyLimit}{' '}
              {usage.dailyLimit === 1 ? 'リクエスト' : 'リクエスト'} 今日残っている
            </p>
            {usage.resetAt && (
              <p className="text-xs text-kumo-subtle mt-1">
                00:00 UTC にリセット{' '}
                <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} />.
              </p>
            )}
          </div>

          {/* Cloudflare connection / credits */}
          <div>
            <p className="text-xs font-medium text-kumo-subtle mb-1">Cloudflareアカウント</p>
            {!usage.connected ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                  <CloudflareLogo size={16} />
                  <span>接続されていません</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  Cloudflare アカウントに接続すると、無料枠が終了した後も構築を続けることができます
                  アウト。無料利用枠を超えた使用量は、独自のCloudflare AI Gatewayに請求されます。
                  クレジット。
                </p>
                <div className="pt-1">
                  <Button variant="primary" size="sm" onClick={connect} loading={busy}>
                    <Lightning size={14} weight="bold" className="mr-1" />
                    Cloudflareに接続する
                  </Button>
                </div>
              </div>
            ) : usage.needsAccountSelection ? (
              // Connected, but multiple accounts — force the user to choose which one to bill.
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <Warning size={18} weight="bold" className="text-kumo-warning" />
                  <span>請求する Cloudflare アカウントを選択してください</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  接続では複数の Cloudflare アカウントにアクセスできます。そのものを選択してください
                  AI ゲートウェイ クレジットを使用する必要があります。
                </p>
                {accounts === null ? (
                  <p className="text-sm text-kumo-subtle">アカウントを読み込み中…</p>
                ) : accounts.length === 0 ? (
                  <p className="text-sm text-kumo-subtle">
                    この接続では利用可能なアカウントがありません。
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {accounts.map((a) => (
                      <Button
                        key={a.accountId}
                        variant="secondary"
                        size="sm"
                        className="justify-start"
                        onClick={() => selectAccount(a.accountId)}
                        loading={selecting === a.accountId}
                        disabled={selecting !== null}
                      >
                        {a.accountName}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <CloudCheck size={18} weight="bold" className="text-kumo-success" />
                  <span>
                    接続済み
                    {usage.accountName && <> — {usage.accountName}</>}
                  </span>
                </div>
                <p className="text-sm text-kumo-default">
                  口座残高:{' '}
                  {usage.balance !== null ? (
                    <strong>${usage.balance.toFixed(2)}</strong>
                  ) : (
                    <span className="text-kumo-subtle">未知</span>
                  )}
                </p>

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => window.open(buildAddCreditsUrl(usage.accountId), '_blank')}
                  >
                    <Lightning size={14} weight="bold" className="mr-1" />
                    クレジットを追加する
                  </Button>
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-kumo-subtle border-t border-kumo-line pt-3">
            詳しくはこちら{' '}
            <a
              href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              AI ゲートウェイの統合請求
            </a>
            .
          </p>
        </div>
      )}
      </div>
    </section>
  )
}
