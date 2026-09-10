import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, InputArea } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { useAgent } from 'agents/react'
import { useAgentChat } from '@cloudflare/ai-chat/react'
import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { describeError } from '../../../../inbox/workers/lib/describe-error'
import { InboxRequestError, inboxErrorMessage, isAbort } from './api'
import { canConnectInboxAgent, inboxAgentPath, loadInboxAgentMessages } from './inboxAgent'

/** Opens a mailbox-scoped conversation without changing the folder/list/message layout. */
export const EmailAgentPanel = ({ mailboxId, onClose, onChanged, onOpenDrafts }: {
  mailboxId: string; onClose: () => void; onChanged: () => void; onOpenDrafts: () => void
}) => {
  const { t } = useTranslation()
  const [history, setHistory] = useState<UIMessage[] | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!canConnectInboxAgent()) return
    const controller = new AbortController()
    const load = async () => {
      try {
        const messages = await loadInboxAgentMessages(mailboxId, controller.signal)
        if (!controller.signal.aborted) setHistory(messages)
      } catch (err) {
        if (!controller.signal.aborted && !isAbort(err)) setError(inboxErrorMessage(err))
      }
    }
    void load()
    return () => controller.abort()
  }, [mailboxId, attempt])

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog className="flex h-[85dvh] max-h-[48rem] w-full max-w-2xl flex-col gap-3 overflow-y-auto bg-kumo-base p-4 text-kumo-default">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <Dialog.Title>{t('workshop-frontend.Inbox.agent_title')}</Dialog.Title>
        <Button variant="ghost" onClick={onClose}>{t('workshop-frontend.Inbox.close')}</Button>
      </div>
      <Dialog.Description>{t('workshop-frontend.Inbox.agent_description')}</Dialog.Description>
      <p className="shrink-0 break-all text-sm text-kumo-subtle">{mailboxId}</p>
      {!canConnectInboxAgent() ? <p role="alert">{t('workshop-frontend.Inbox.agent_access_required')}</p> : history ? <AgentConversation initialMessages={history} mailboxId={mailboxId} onChanged={onChanged} onOpenDrafts={onOpenDrafts} /> : error ? <div>
        <p role="alert" className="text-kumo-danger">{error}</p>
        <Button variant="secondary" onClick={() => { setError(''); setAttempt(value => value + 1) }}>{t('workshop-frontend.Inbox.retry')}</Button>
      </div> : <p role="status">{t('workshop-frontend.Inbox.loading')}</p>}
    </Dialog>
  </Dialog.Root>
}

/** Renders server tool results as progress, without exposing their mail bodies or registering tools. */
const AgentConversation = ({ initialMessages, mailboxId, onChanged, onOpenDrafts }: {
  initialMessages: UIMessage[]; mailboxId: string; onChanged: () => void; onOpenDrafts: () => void
}) => {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [connected, setConnected] = useState(false)
  const [connectionFailed, setConnectionFailed] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const pendingInput = useRef('')
  const mounted = useRef(true)
  const seenResults = useRef(new Set<string>())
  const log = useRef<HTMLDivElement>(null)
  const followTail = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const agent = useAgent({
    agent: 'EMAIL_AGENT', name: mailboxId, basePath: inboxAgentPath(mailboxId).slice(1),
    // A browser hides handshake HTTP status, so every failed connection requires an explicit retry.
    maxRetries: 0,
    onOpen: () => { setConnected(true); setConnectionFailed(false) },
    onClose: () => { setConnected(false); setConnectionFailed(true) },
    onError: () => {
      setConnected(false); setConnectionFailed(true)
      console.error('[connectInboxAgent] failed', { err: describeError(new InboxRequestError(t('workshop-frontend.Inbox.agent_connection_failed'))) })
    },
  })
  const handleError = (err: unknown) => {
    if (!mounted.current || isAbort(err)) return
    console.error('[sendInboxAgentMessage] failed', { err: describeError(err) })
    setError(inboxErrorMessage(err))
    setInput(current => current || pendingInput.current)
  }
  const { messages, sendMessage, status } = useAgentChat({
    agent, messages: initialMessages, getInitialMessages: null, onError: handleError,
  })
  const busy = status === 'submitted' || status === 'streaming'

  // Observe streamed and restored server output, including a draft saved before a later step fails.
  // A completed call only invalidates resources once, regardless of subsequent token updates.
  useEffect(() => {
    let changed = false
    for (const message of messages) for (const part of message.parts) {
      if (!isToolUIPart(part) || part.state !== 'output-available' || part.preliminary) continue
      const key = `${message.id}:${part.toolCallId}`
      if (seenResults.current.has(key)) continue
      seenResults.current.add(key)
      const tool = getToolName(part)
      const output = part.output
      if (!output || typeof output !== 'object' || 'error' in output || !('status' in output)) continue
      if (((tool === 'draft_email' || tool === 'draft_reply') && output.status === 'draft_saved') ||
        (tool === 'mark_email_read' && output.status === 'updated') ||
        (tool === 'move_email' && output.status === 'moved') ||
        (tool === 'discard_draft' && output.status === 'discarded')) changed = true
    }
    if (changed) onChanged()
  }, [messages, onChanged])
  useEffect(() => {
    if (followTail.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [messages, status])

  const submit = async () => {
    if (!input.trim() || busy || submitting.current || !connected) return
    submitting.current = true; pendingInput.current = input
    setInput(''); setError(''); followTail.current = true
    try {
      await sendMessage({ text: pendingInput.current })
    } catch (err) {
      handleError(err)
    } finally {
      submitting.current = false
    }
  }

  return <>
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-kumo-subtle">
      <span>{t(`workshop-frontend.Inbox.${connected ? busy ? 'agent_working' : 'agent_connected' : connectionFailed ? 'agent_connection_failed' : 'agent_connecting'}`)}</span>
      {!connected && connectionFailed && <Button size="sm" variant="secondary" onClick={() => { setConnectionFailed(false); agent.reconnect() }}>{t('workshop-frontend.Inbox.retry')}</Button>}
    </div>
    <div ref={log} role="log" aria-label={t('workshop-frontend.Inbox.agent_conversation')} aria-live="polite" className="min-h-24 min-w-0 flex-1 space-y-4 overflow-y-auto rounded-lg border border-kumo-line p-3" onScroll={event => {
      const element = event.currentTarget
      const tailThreshold = 48 // Preserve the reading position when the user scrolls into history.
      followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < tailThreshold
    }}>
      {messages.length === 0 && <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.agent_empty')}</p>}
      {messages.filter(message => message.role !== 'system').map(message => <article key={message.id} className="min-w-0 space-y-2">
        <p className="text-sm font-semibold">{t(`workshop-frontend.Inbox.${message.role === 'user' ? 'agent_you' : 'agent_title'}`)}</p>
        {message.parts.map((part, index) => {
          if (part.type === 'text') return <p key={index} className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{part.text}</p>
          if (!isToolUIPart(part)) return null
          const outputFailed = part.state === 'output-available' && !!part.output && typeof part.output === 'object' && 'error' in part.output
          const progress = part.state === 'output-error' || part.state === 'output-denied' || outputFailed ? 'failed' :
            part.state === 'output-available' && !part.preliminary ? 'done' : part.state === 'input-streaming' ? 'preparing' : 'running'
          return <p key={part.toolCallId} className={`rounded-md bg-kumo-elevated px-3 py-2 text-sm ${progress === 'failed' ? 'text-kumo-danger' : 'text-kumo-default'}`}>
            {t(`workshop-frontend.Inbox.agent_tool_${getToolName(part)}`, t('workshop-frontend.Inbox.agent_tool'))}{' — '}{t(`workshop-frontend.Inbox.agent_tool_${progress}`)}
          </p>
        })}
      </article>)}
    </div>
    {error && <p role="alert" className="shrink-0 text-sm text-kumo-danger">{error}</p>}
    <form className="shrink-0 space-y-2" onSubmit={event => { event.preventDefault(); void submit() }}>
      <InputArea label={t('workshop-frontend.Inbox.agent_input')} value={input} onChange={event => setInput(event.target.value)} rows={3} disabled={busy} />
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="secondary" onClick={onOpenDrafts}>{t('workshop-frontend.Inbox.agent_open_drafts')}</Button>
        <Button type="submit" disabled={!connected || busy || !input.trim()}>{t('workshop-frontend.Inbox.agent_submit')}</Button>
      </div>
      {busy && <p className="text-xs text-kumo-subtle">{t('workshop-frontend.Inbox.agent_background')}</p>}
    </form>
  </>
}
