import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { Button, Dialog } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import type { ContextApi, ContextDocument } from '../../../../gatekeeper-context/src/context-types'
import { useAuthenticatedApi } from '../../AuthContext'
import { SaveToWorkset } from '../links/SaveToWorkset'

/** Reads one document through the account capability; HTML and code stay inert text. */
export const ContextPreview = ({ collectionId, path, onClose }: { collectionId: string; path: string; onClose: () => void }) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { t } = useTranslation()
  const [document, setDocument] = useState<ContextDocument | null>()
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    setDocument(undefined); setError(false)
    void (async () => {
      const frame = await authenticatedApi.getGatekeeperApp('context')
      if (!frame) throw new Error('Context unavailable')
      using context = frame.ui as RpcStub<ContextApi>
      if (cancelled) return
      const result = await context.getContextDocument(collectionId, path)
      if (!cancelled) setDocument(result)
    })().catch(error => { if (!cancelled) { console.error('[workHub.document] failed', { error }); setError(true) } })
    return () => { cancelled = true }
  }, [authenticatedApi, collectionId, path, revision])
  const href = `${window.location.origin}/search?${new URLSearchParams({ collection: collectionId, document: path })}`
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog className="flex max-h-[90dvh] w-full max-w-3xl flex-col gap-4 p-5"><Dialog.Title>{document?.name ?? path}</Dialog.Title><Dialog.Description>{document?.description || t('workshop-frontend.WorkHub.context')}</Dialog.Description>
    {error ? <div role="alert"><p>{t('workshop-frontend.WorkHub.load_failed')}</p><Button onClick={() => setRevision(value => value + 1)}>{t('workshop-frontend.Inbox.retry')}</Button></div> : document === undefined ? <p role="status">{t('workshop-frontend.Inbox.loading')}</p> : document === null ? <p>{t('workshop-frontend.WorkHub.document_missing')}</p> : /^(text\/|application\/(json|xml|(?:x-)?yaml))/.test(document.contentType) ? <pre className="min-h-0 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{document.body}</pre> : <p>{t('workshop-frontend.WorkHub.binary_document')}</p>}
    <div className="flex flex-wrap justify-end gap-2"><SaveToWorkset destination={{ title: document?.name || path, url: href }} /><Button onClick={onClose}>{t('workshop-frontend.Inbox.close')}</Button></div>
  </Dialog></Dialog.Root>
}
