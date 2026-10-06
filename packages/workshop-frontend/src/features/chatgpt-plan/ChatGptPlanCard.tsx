import { useEffect, useRef, useState } from 'react'
import { Button, InputArea, useKumoToastManager } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import type { ChatGptPlanConnectionInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { connectionCommand } from './connectionCommand'

/** Connection instructions stay on Providers, even when clipboard access is unavailable. */
export const ChatGptPlanCard = ({ onModelsChange }: { onModelsChange: () => Promise<void> }) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { t } = useTranslation()
  const toasts = useKumoToastManager()
  const [connection, setConnection] = useState<ChatGptPlanConnectionInfo>({ connected: false })
  const [modelCount, setModelCount] = useState<number | null>(null)
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const generation = useRef(0)

  useEffect(() => {
    const attempt = ++generation.current
    setBusy(true)
    authenticatedApi.getChatGptPlanConnection().then(status => {
      if (attempt === generation.current) setConnection(status)
    }).catch(() => {
      if (attempt === generation.current) setError(t('workshop-frontend.chatgpt.load_error'))
    }).finally(() => {
      if (attempt === generation.current) setBusy(false)
    })
    return () => { ++generation.current }
  }, [authenticatedApi, t])

  const refresh = async () => {
    if (busy) return
    const attempt = ++generation.current
    setBusy(true)
    setError('')
    try {
      const status = await authenticatedApi.getChatGptPlanConnection()
      if (attempt !== generation.current) return
      setConnection(status)
      if (status.connected) {
        setCommand('')
        const models = await authenticatedApi.listChatGptPlanModels()
        if (attempt !== generation.current) return
        setModelCount(models.length)
      } else {
        setModelCount(null)
      }
      await onModelsChange()
    } catch {
      if (attempt === generation.current) setError(t('workshop-frontend.chatgpt.load_error'))
    } finally {
      if (attempt === generation.current) setBusy(false)
    }
  }

  const connect = async () => {
    if (busy) return
    const attempt = ++generation.current
    setBusy(true)
    setError('')
    try {
      const handoff = await authenticatedApi.createChatGptPlanHandoff()
      if (attempt === generation.current) setCommand(connectionCommand(window.location.origin, handoff))
    } catch {
      if (attempt === generation.current) setError(t('workshop-frontend.chatgpt.connect_error'))
    } finally {
      if (attempt === generation.current) setBusy(false)
    }
  }

  const disconnect = async () => {
    if (busy) return
    const attempt = ++generation.current
    setBusy(true)
    setError('')
    try {
      const { revoked } = await authenticatedApi.disconnectChatGptPlan()
      if (attempt !== generation.current) return
      setConnection({ connected: false })
      setModelCount(null)
      setCommand('')
      if (!revoked) setError(t('workshop-frontend.chatgpt.revocation_unconfirmed'))
      await onModelsChange()
    } catch {
      if (attempt === generation.current) setError(t('workshop-frontend.chatgpt.disconnect_error'))
    } finally {
      if (attempt === generation.current) setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      toasts.add({ title: t('workshop-frontend.chatgpt.copied'), variant: 'success' })
    } catch {
      setError(t('workshop-frontend.chatgpt.clipboard_error'))
    }
  }

  return <section aria-label="ChatGPT plan" className="rounded-xl border border-kumo-line bg-kumo-base p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-kumo-default">ChatGPT plan</p>
        <p aria-live="polite" className="mt-1 text-sm text-kumo-subtle">
          {connection.connected
            ? t('workshop-frontend.chatgpt.connected', { email: connection.email ?? 'ChatGPT' })
            : t('workshop-frontend.chatgpt.description')}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>{t('workshop-frontend.chatgpt.refresh')}</Button>
        {connection.connected
          ? <Button variant="secondary" disabled={busy} onClick={() => void disconnect()}>{t('workshop-frontend.chatgpt.disconnect')}</Button>
          : <Button disabled={busy} onClick={() => void connect()}>{t('workshop-frontend.chatgpt.continue')}</Button>}
      </div>
    </div>
    {connection.connected && <div className="mt-3 space-y-1 text-sm text-kumo-subtle">
      <p>{t('workshop-frontend.chatgpt.select_model')}</p>
      {modelCount !== null && <p>{t('workshop-frontend.chatgpt.model_count', { count: modelCount })}</p>}
      <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer" className="text-kumo-brand underline">{t('workshop-frontend.chatgpt.manage_usage')}</a>
    </div>}
    {command && <div className="mt-4 space-y-3">
      <p className="text-sm text-kumo-subtle">{t('workshop-frontend.chatgpt.instructions')}</p>
      <a href="https://github.com/y-128/cloudflare-os/blob/feat/chatgpt-plan-auth/docs/chatgpt-plan.md" target="_blank" rel="noreferrer" className="text-sm text-kumo-brand underline">{t('workshop-frontend.chatgpt.setup')}</a>
      <InputArea label={t('workshop-frontend.chatgpt.command')} value={command} readOnly rows={4} className="font-mono text-xs" />
      <p className="text-xs text-kumo-subtle">{t('workshop-frontend.chatgpt.expires')}</p>
      <Button variant="secondary" onClick={() => void copy()}>{t('workshop-frontend.chatgpt.copy')}</Button>
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-kumo-danger">{error}</p>}
  </section>
}
