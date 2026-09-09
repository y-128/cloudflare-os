import { useTranslation, renderTranslation } from "@gadgets/i18n";
import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Dialog, Button, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { CloudWarning, Lightning } from '@phosphor-icons/react'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { buildAddCreditsUrl } from './creditsUrl'
import ResetCountdown from './ResetCountdown'

interface OutOfCreditsModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Modal shown when a user has exhausted their free daily allowance. Guides them to connect their
 * Cloudflare account (if not connected), pick which account to bill (if they have several), or top
 * up credits in the Cloudflare dashboard (if connected but low balance).
 */
export default function OutOfCreditsModal({ open, onClose }: OutOfCreditsModalProps) {
  const { t } = useTranslation();
  const auth = useOptionalAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [usage, setUsage] = useState<CloudflareUsageInfo | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!auth) return
    auth.authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => setUsage(u))
      .catch(() => {})
  }, [auth])

  useEffect(() => {
    if (!open || !auth) return
    setUsage(null)
    setAccounts(null)
    refresh()
    // Re-check when the tab regains focus, so returning from the "Connect Cloudflare" OAuth pop-up
    // updates the modal (connected state / balance / account list) without reopening it.
    const onFocus = () => {
      setAccounts(null)
      refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [open, auth, refresh])

  // Load the account list when the server says the user must pick one.
  useEffect(() => {
    if (!auth) return
    if (usage?.connected && usage.needsAccountSelection && accounts === null) {
      auth.authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => setAccounts(list))
        .catch(() => setAccounts([]))
    }
  }, [auth, usage, accounts])

  const connect = async () => {
    if (!auth) return
    setConnecting(true)
    try {
      const { url } = await auth.authenticatedApi.connectAccount('cloudflare', [])
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      // ignore
    } finally {
      setConnecting(false)
    }
  }

  const selectAccount = async (accountId: string) => {
    if (!auth) return
    setSelecting(accountId)
    try {
      await auth.authenticatedApi.selectCloudflareAccount(accountId)
      setAccounts(null)
      refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("workshop-frontend.UsageSettings.failed_to_select_account")
      toasts.add({ title: msg, variant: 'error' })
    } finally {
      setSelecting(null)
    }
  }

  const connected = usage?.connected ?? false
  const needsSelection = connected && (usage?.needsAccountSelection ?? false)

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="responsive-dialog overflow-y-auto p-6 sm:w-[560px]" size="base">
        <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
          <CloudWarning size={22} weight="bold" className="text-kumo-warning" />{t("workshop-frontend.OutOfCreditsModal.you_ve_reached_your_free_usage_limit")}</Dialog.Title>

        {usage === null ? (
          <div className="flex justify-center py-8"><Loader size="base" /></div>
        ) : (
          <div className="space-y-4">
            {!connected ? (
              <p className="text-sm text-kumo-subtle">
                {renderTranslation(t("workshop-frontend.OutOfCreditsModal.you_ve_used_all_free_requests_for_today_connect_your_cloudflare_a"), { n: usage.dailyLimit, reset: usage.resetAt ? renderTranslation(t("workshop-frontend.UsageSettings.free_requests_reset"), { countdown: <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} /> }) : null })}</p>
            ) : needsSelection ? (
              <p className="text-sm text-kumo-subtle">
                {t("workshop-frontend.OutOfCreditsModal.your_cloudflare_connection_has_access_to_multiple_accounts_choose")}</p>
            ) : (
              <p className="text-sm text-kumo-subtle">
                {renderTranslation(t("workshop-frontend.OutOfCreditsModal.your_cloudflare_account_is_connected_but_its_balance_is_below_the"), { balance: usage.balance !== null ? t("workshop-frontend.UsageSettings.credit_balance", { balance: usage.balance.toFixed(2) }) : null, reset: usage.resetAt ? renderTranslation(t("workshop-frontend.UsageSettings.free_requests_reset"), { countdown: <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} /> }) : null })}</p>
            )}

            {needsSelection && (
              <div className="flex flex-col gap-2">
                {accounts === null ? (
                  <p className="text-sm text-kumo-subtle">{t("workshop-frontend.OutOfCreditsModal.loading_accounts")}</p>
                ) : accounts.length === 0 ? (
                  <p className="text-sm text-kumo-subtle">{t("workshop-frontend.OutOfCreditsModal.no_accounts_available_on_this_connection")}</p>
                ) : (
                  accounts.map((a) => (
                    <Button
                      key={a.accountId}
                      variant="secondary"
                      className="justify-start"
                      onClick={() => selectAccount(a.accountId)}
                      loading={selecting === a.accountId}
                      disabled={selecting !== null}
                    >
                      {a.accountName}
                    </Button>
                  ))
                )}
              </div>
            )}

            <p className="text-sm text-kumo-subtle">
              {renderTranslation(t("workshop-frontend.OutOfCreditsModal.learn_more_about_2"), { link: <a
                href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {t("workshop-frontend.OutOfCreditsModal.ai_gateway_unified_billing")}</a> })}</p>

            <div className="flex items-center justify-end gap-2 pt-2">
              {!connected ? (
                <>
                  <Button variant="secondary" onClick={onClose}>{t("workshop-frontend.OutOfCreditsModal.maybe_later")}</Button>
                  <Button variant="primary" onClick={connect} loading={connecting}>
                    <Lightning size={16} weight="bold" />{t("workshop-frontend.OutOfCreditsModal.connect_cloudflare")}</Button>
                </>
              ) : needsSelection ? (
                <Button variant="secondary" onClick={onClose}>{t("workshop-frontend.OutOfCreditsModal.close")}</Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={onClose}>{t("workshop-frontend.OutOfCreditsModal.close")}</Button>
                  <Button
                    variant="primary"
                    onClick={() => window.open(buildAddCreditsUrl(usage.accountId), '_blank')}
                  >
                    {t("workshop-frontend.OutOfCreditsModal.add_credits_in_cloudflare")}</Button>
                </>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
