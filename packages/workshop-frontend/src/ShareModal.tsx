import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { Checkbox, Dialog, DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import type { PortalContainer } from '@cloudflare/kumo'
import { CaretDown, Check, Copy, Link, PencilSimple, ShieldCheck, ShieldWarning, Trash, UserPlus, X } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import {
  Overseer,
  AuthenticatedApi,
  CollaboratorInfo,
  AffectedCollaborator,
  ShareLinkInfo,
  GadgetMetadata,
  AiChatAuthorInfo,
  CollaboratorRole,
  ObserverBindingNeed,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import { PersonAvatar } from './components/PersonAvatar'
import { copyToClipboard } from './clipboard'

type CollaboratorRow =
  | { kind: 'owner'; profile: AiChatAuthorInfo }
  | { kind: 'collaborator'; info: CollaboratorInfo }

type ConfirmationTarget =
  | { kind: 'remove'; profileId: string; dependents: AffectedCollaborator[]; previewing: boolean; keepSet: Set<string> }
  | { kind: 'revoke'; linkId: string; dependents: AffectedCollaborator[]; previewing: boolean; keepSet: Set<string> }

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  currentUser: AiChatAuthorInfo | null
  authenticatedApi: RpcStub<AuthenticatedApi>
}

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return 'たった今'
  if (diffMinutes < 60) return `${diffMinutes}分前`
  if (diffHours < 24) return `${diffHours}時間前`
  if (diffDays < 7) return `${diffDays}日前`
  return date.toLocaleDateString('ja-JP')
}

const ROLE_LABELS: Record<CollaboratorRole, string> = {
  build: 'ワークスペース',
  use: 'ガジェットのみ',
}

const ROLE_DESCRIPTIONS: Record<CollaboratorRole, string> = {
  build: 'ガジェットの編集、チャットの利用、アクセス管理ができます。',
  use: 'エージェントとのチャットや編集をせずにガジェットを利用できます。',
}

function roleLabel(role: CollaboratorRole | undefined): string {
  return ROLE_LABELS[role ?? 'build']
}

const ROLE_OPTIONS: CollaboratorRole[] = ['build', 'use']

function RoleMenu({
  value,
  onValueChange,
  disabled,
  ariaLabel,
  container,
}: {
  value: CollaboratorRole
  onValueChange: (role: CollaboratorRole) => void
  disabled?: boolean
  ariaLabel: string
  container?: PortalContainer
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        disabled={disabled}
        render={
          <button
            type="button"
            className="group inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] leading-4 font-medium text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={ariaLabel}
          >
            {roleLabel(value)}
            <CaretDown size={11} weight="bold" className="text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180" />
          </button>
        }
      />
      <DropdownMenu.Content
        container={container}
        align="end"
        sideOffset={6}
        className="themed-floating-shadow-lg !z-[1100] !w-[300px] !min-w-0 rounded-2xl border border-kumo-line/70 bg-kumo-base p-1 !ring-kumo-line"
      >
        {ROLE_OPTIONS.map(role => (
          <DropdownMenu.Item
            key={role}
            onClick={() => onValueChange(role)}
            className="!h-auto cursor-pointer rounded-xl !px-2.5 !py-2 text-kumo-default transition-colors data-highlighted:bg-kumo-tint/70"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] leading-4 font-medium">{roleLabel(role)}</span>
              <span className="mt-0.5 block text-[11px] leading-4 font-normal text-kumo-subtle">
                {ROLE_DESCRIPTIONS[role]}
              </span>
            </span>
            <span className="ml-2 flex h-4 w-4 shrink-0 items-center justify-center">
              {value === role && <Check size={13} weight="bold" className="text-kumo-brand" />}
            </span>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

function RoleBadge({ role }: { role: CollaboratorRole | undefined }) {
  const isBuild = (role ?? 'build') === 'build'
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-[3px] text-[11px] leading-4 font-medium tracking-[-0.1px] ${
        isBuild
          ? 'border-kumo-line bg-kumo-tint/70 text-kumo-default'
          : 'border-kumo-line/70 bg-kumo-base text-kumo-subtle'
      }`}
    >
      {roleLabel(role)}
    </span>
  )
}

function InlineConfirm({
  label,
  busy,
  busyLabel,
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  label: string
  busy: boolean
  busyLabel?: string
  tone?: 'danger' | 'brand'
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex items-center gap-1 share-confirm-in">
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className={`inline-flex h-7 cursor-pointer items-center rounded-lg px-2.5 text-[12px] leading-4 font-medium tracking-[-0.1px] transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] disabled:opacity-60 ${
          tone === 'danger'
            ? 'text-kumo-danger hover:bg-kumo-danger-tint'
            : 'text-kumo-brand hover:bg-kumo-tint'
        }`}
      >
        {busy ? (busyLabel ?? `${label}…`) : label}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label="キャンセル"
        className="grid h-7 w-7 cursor-pointer place-items-center rounded-lg text-kumo-inactive transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default active:scale-[0.96] disabled:opacity-60"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function DependentKeepList({
  dependents,
  keepSet,
  onKeepSetChange,
}: {
  dependents: AffectedCollaborator[]
  keepSet: Set<string>
  onKeepSetChange: (next: Set<string>) => void
}) {
  if (dependents.length === 0) return null

  return (
    <div className="space-y-1.5">
      {dependents.map(dep => (
        <div
          key={dep.profile.id}
          className={`rounded-xl px-3 py-2 transition-colors ${
            keepSet.has(dep.profile.id) ? 'bg-kumo-tint' : 'bg-kumo-elevated/50 hover:bg-kumo-elevated'
          }`}
        >
          <Checkbox
            label={(
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate text-[12px] font-medium text-kumo-default">{dep.profile.name}</span>
                <span className="truncate text-[11px] text-kumo-subtle">{dep.profile.id}</span>
              </span>
            )}
            checked={keepSet.has(dep.profile.id)}
            onCheckedChange={(checked) => {
              const next = new Set(keepSet)
              if (checked) next.add(dep.profile.id)
              else next.delete(dep.profile.id)
              onKeepSetChange(next)
            }}
          />
        </div>
      ))}
    </div>
  )
}

// What a recipient is asked to do before the workspace will open for them. Recipients don't
// inherit the owner's connections: they must point their own account at each connection in scope
// for the selected access level, so sharers should know that cost before they invite anyone.
function RecipientVerification({
  requirements,
  failed,
  role,
  headingId,
  heading,
}: {
  requirements: ObserverBindingNeed[] | null
  failed: boolean
  role?: CollaboratorRole
  headingId: string
  heading: string
}) {
  let body: ReactNode
  if (failed) {
    body = (
      <p className="px-1 text-[12px] leading-[16px] tracking-[-0.15px] text-kumo-subtle">
        受信者がどの接続を確認する必要があるかを確認できませんでした。
      </p>
    )
  } else if (requirements === null || requirements.length === 0) {
    // Still loading: stay silent rather than reserving space for an answer we don't have yet.
    return null
  } else {
    body = (
      <div className="rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-2.5">
        <p className="text-[12px] leading-[16px] tracking-[-0.15px] text-kumo-subtle">
          {role ? (
            <><span className="font-medium text-kumo-default">{roleLabel(role)}</span>権限を持つ人は</>
          ) : '受信者は'}、自分のアカウントで以下へアクセスできることを確認する必要があります。
        </p>
        <ul className="mt-1.5 max-h-32 space-y-1 overflow-y-auto">
          {requirements.map(requirement => (
            <li key={requirement.gatekeeperId} className="min-w-0">
              <p className="truncate text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-default">
                {requirement.resourceTitle}
              </p>
              {requirement.resourceUrl && (
                <p className="truncate font-mono text-[11px] leading-4 text-kumo-inactive">
                  {requirement.resourceUrl}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <section aria-labelledby={headingId} className="mt-4">
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <ShieldCheck size={13} className="text-kumo-inactive" />
        <h3 id={headingId} className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
          {heading}
        </h3>
      </div>
      {body}
    </section>
  )
}

function sameRequirements(
  left: ObserverBindingNeed[],
  right: ObserverBindingNeed[],
): boolean {
  return left.length === right.length &&
    left.every((requirement, index) => requirement.gatekeeperId === right[index].gatekeeperId)
}

export default function ShareModal({ open, onClose, overseer, metadata, currentUser, authenticatedApi }: Props) {
  const toasts = useKumoToastManager()
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [shareLinks, setShareLinks] = useState<ShareLinkInfo[]>([])
  const [addUsername, setAddUsername] = useState('')
  const [addRole, setAddRole] = useState<CollaboratorRole>('use')
  const [adding, setAdding] = useState(false)
  const [newLinkRole, setNewLinkRole] = useState<CollaboratorRole>('use')
  const [newLinkNote, setNewLinkNote] = useState('')
  const [newShareLink, setNewShareLink] = useState<string | null>(null)
  const [newShareLinkId, setNewShareLinkId] = useState<string | null>(null)
  const [newShareLinkCopied, setNewShareLinkCopied] = useState(false)
  const [invitedName, setInvitedName] = useState<string | null>(null)
  const [invitedLinkCopied, setInvitedLinkCopied] = useState(false)
  const [requirements, setRequirements] =
    useState<Record<CollaboratorRole, ObserverBindingNeed[]> | null>(null)
  const [requirementsFailed, setRequirementsFailed] = useState(false)
  const [creatingLink, setCreatingLink] = useState(false)
  const [showLinkComposer, setShowLinkComposer] = useState(false)
  const [confirmationTarget, setConfirmationTarget] = useState<ConfirmationTarget | null>(null)
  const [confirmationBusy, setConfirmationBusy] = useState(false)
  const wasOpenRef = useRef(false)
  const creatingLinkRef = useRef(false)
  const addingRef = useRef(false)
  const landedTimerRef = useRef<number | null>(null)
  const [menuContainer, setMenuContainer] = useState<PortalContainer>(null)
  const [scrolled, setScrolled] = useState(false)
  const [landedPersonId, setLandedPersonId] = useState<string | null>(null)
  const [landedShareLinkId, setLandedShareLinkId] = useState<string | null>(null)
  const [editingShareLinkId, setEditingShareLinkId] = useState<string | null>(null)
  const [editingShareLinkNote, setEditingShareLinkNote] = useState('')
  const [savingShareLinkNote, setSavingShareLinkNote] = useState(false)
  const [copyingLinkId, setCopyingLinkId] = useState<string | null>(null)
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)
  const linkNameRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const savingShareLinkNoteRef = useRef(false)
  const copyingLinkRef = useRef(false)
  const copiedTimerRef = useRef<number | null>(null)
  // Freshly-minted share URLs, kept only in memory for the life of this modal session so repeat
  // Copy clicks on the same link re-use the URL.
  const copiedUrlsRef = useRef<Map<string, string>>(new Map())

  // Focus the link-name field when the composer opens, without scrolling the sticky region
  // (autoFocus would jump the scroll position and shift layout).
  useEffect(() => {
    if (showLinkComposer && !newShareLink) {
      linkNameRef.current?.focus({ preventScroll: true })
    }
  }, [showLinkComposer, newShareLink])

  useEffect(() => {
    if (editingShareLinkId) {
      renameInputRef.current?.focus({ preventScroll: true })
      renameInputRef.current?.select()
    }
  }, [editingShareLinkId])

  useEffect(() => {
    return () => {
      if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const element = document.createElement('div')
    element.style.position = 'relative'
    element.style.zIndex = '1100'
    document.body.appendChild(element)
    setMenuContainer(element)
    return () => {
      setMenuContainer(null)
      element.remove()
    }
  }, [])

  const isOwner = !metadata.owner
  const sharingProhibited = metadata.sharingProhibited === true

  const loadData = useCallback(async () => {
    try {
      const [collabs, keys] = await Promise.all([
        overseer.listCollaborators(),
        overseer.listShareLinks(),
      ])
      setCollaborators(collabs)
      setShareLinks(keys)
      return { collaborators: collabs, shareLinks: keys }
    } catch (err) {
      console.error('Failed to load share data:', err)
      toasts.add({ title: '共有情報の読み込みに失敗しました', variant: 'error' })
      return null
    }
  }, [overseer])

  // Refresh on focus as well as open: bindings cannot change in this modal, but they can change in
  // another tab while it remains open. A failed refresh is informational and never blocks sharing.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let requestId = 0
    setRequirements(null)
    const refresh = () => {
      const thisRequest = ++requestId
      setRequirementsFailed(false)
      Promise.all([
        overseer.listObserverRequirements('use'),
        overseer.listObserverRequirements('build'),
      ])
        .then(([use, build]) => {
          if (!cancelled && thisRequest === requestId) setRequirements({ use, build })
        })
        .catch(err => {
          console.error('Failed to load observer requirements:', err)
          if (!cancelled && thisRequest === requestId) setRequirementsFailed(true)
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [open, overseer])

  useEffect(() => {
    if (open) {
      loadData()
      if (!wasOpenRef.current) {
        setAddUsername('')
        setNewShareLink(null)
        setNewShareLinkId(null)
        setNewShareLinkCopied(false)
        setInvitedName(null)
        setInvitedLinkCopied(false)
        setNewLinkNote('')
        setShowLinkComposer(false)
        setConfirmationTarget(null)
        setEditingShareLinkId(null)
        setEditingShareLinkNote('')
        setCopiedLinkId(null)
        setCopyingLinkId(null)
        if (copiedTimerRef.current !== null) {
          window.clearTimeout(copiedTimerRef.current)
          copiedTimerRef.current = null
        }
        copiedUrlsRef.current.clear()
      }
    }
    wasOpenRef.current = open
  }, [open, loadData])

  const ownerProfile: AiChatAuthorInfo | null = isOwner ? currentUser : (metadata.owner ?? null)
  const collaboratorRows: CollaboratorRow[] = [
    ...(ownerProfile ? [{ kind: 'owner' as const, profile: ownerProfile }] : []),
    ...collaborators.map(info => ({ kind: 'collaborator' as const, info })),
  ]
  const sortedShareLinks = useMemo(
    () => [...shareLinks].toSorted((a, b) => b.created.getTime() - a.created.getTime()),
    [shareLinks],
  )
  let recipientVerification: ReactNode = null
  if (requirementsFailed) {
    recipientVerification = (
      <RecipientVerification
        requirements={null}
        failed
        headingId="recipient-verification-heading"
        heading="Recipient verification"
      />
    )
  } else if (requirements !== null) {
    const inviteRequirements = requirements[addRole]
    if (!showLinkComposer && !newShareLink) {
      recipientVerification = (
        <RecipientVerification
          requirements={inviteRequirements}
          failed={false}
          role={addRole}
          headingId="recipient-verification-heading"
          heading="Recipient verification"
        />
      )
    } else {
      const linkRequirements = requirements[newLinkRole]
      if (sameRequirements(inviteRequirements, linkRequirements)) {
        recipientVerification = (
          <RecipientVerification
            requirements={inviteRequirements}
            failed={false}
            role={addRole === newLinkRole ? addRole : undefined}
            headingId="recipient-verification-heading"
            heading="Recipient verification"
          />
        )
      } else {
        recipientVerification = (
          <>
            <RecipientVerification
              requirements={inviteRequirements}
              failed={false}
              role={addRole}
              headingId="invite-verification-heading"
              heading="Direct invite verification"
            />
            <RecipientVerification
              requirements={linkRequirements}
              failed={false}
              role={newLinkRole}
              headingId="link-verification-heading"
              heading="Share-link verification"
            />
          </>
        )
      }
    }
  }
  const removeTarget = confirmationTarget?.kind === 'remove' ? confirmationTarget : null
  const revokeTarget = confirmationTarget?.kind === 'revoke' ? confirmationTarget : null

  const describeAccess = (info: CollaboratorInfo): string => {
    if (info.addedBy.length > 1) return `Access from ${info.addedBy.length} sources`
    const edge = info.addedBy[0]
    if (!edge) return 'Collaborator'
    if (edge.type === 'user') return `Added directly by ${edge.sharer}`
    const key = shareLinks.find(item => item.linkId === edge.keyId)
    return key?.note ? `Joined through “${key.note}”` : 'Joined through a share link'
  }

  const copyNewLink = async () => {
    if (!newShareLink) return
    const copied = await copyToClipboard(newShareLink)
    if (copied) {
      setNewShareLinkCopied(true)
    } else {
      toasts.add({ title: '共有リンクをコピーできませんでした。', variant: 'error' })
    }
  }

  // Where an invited collaborator opens the workspace. Adding them already granted access, so this
  // carries no secret and is safe to show and re-show — unlike a share link, whose URL embeds a key.
  const workspaceUrl = `${window.location.origin}/workspace/${metadata.id}`

  const copyWorkspaceUrl = async () => {
    if (await copyToClipboard(workspaceUrl)) {
      setInvitedLinkCopied(true)
    } else {
      toasts.add({ title: 'ワークスペースのリンクをコピーできませんでした。', variant: 'error' })
    }
  }

  const showLandedRow = (kind: 'person' | 'shareLink', id: string) => {
    if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current)
    setLandedPersonId(kind === 'person' ? id : null)
    setLandedShareLinkId(kind === 'shareLink' ? id : null)
    landedTimerRef.current = window.setTimeout(() => {
      setLandedPersonId(null)
      setLandedShareLinkId(null)
      landedTimerRef.current = null
    }, 2200)
  }

  const handleAddCollaborator = async () => {
    const username = addUsername.trim()
    if (!username || sharingProhibited || addingRef.current) return

    addingRef.current = true
    setAdding(true)
    try {
      const result = await overseer.addCollaborator(username, addRole, undefined)
      if (result === null) {
        toasts.add({ title: 'そのユーザー名のアカウントが見つかりませんでした。', variant: 'error' })
      } else {
        const landedId = result.profile.id
        setAddUsername('')
        setInvitedName(result.profile.name)
        setInvitedLinkCopied(false)
        await loadData()
        showLandedRow('person', landedId)
        toasts.add({ title: `Added ${result.profile.name} as a collaborator.`, variant: 'success' })
      }
    } catch (err: any) {
      toasts.add({ title: err.message || '共同作業者の追加に失敗しました。', variant: 'error' })
    } finally {
      addingRef.current = false
      setAdding(false)
    }
  }

  const handleCreateShareLink = async () => {
    if (sharingProhibited || creatingLinkRef.current) return
    creatingLinkRef.current = true
    setCreatingLink(true)
    try {
      const { key, linkId } = await overseer.createShareLink(
        newLinkRole, newLinkNote.trim() || undefined)
      const url = `${window.location.origin}/workspace/${metadata.id}#share=${key}`
      setNewShareLink(url)
      setNewShareLinkCopied(false)
      setNewLinkNote('')
      setNewShareLinkId(linkId)
      copiedUrlsRef.current.set(linkId, url)
      await loadData()
      showLandedRow('shareLink', linkId)
    } catch (err: any) {
      // Keep the composer and its values open so the user can retry without re-entering them.
      toasts.add({ title: err.message || '共有リンクの作成に失敗しました。', variant: 'error' })
    } finally {
      creatingLinkRef.current = false
      setCreatingLink(false)
    }
  }

  // Copy a share link again. Secrets are never stored, so the previously-shown URL can't be
  // re-displayed. We mint a new secret for the same logical link and copy that.
  const handleCopyShareLink = async (linkId: string) => {
    if (sharingProhibited || copyingLinkRef.current) return
    copyingLinkRef.current = true
    setCopyingLinkId(linkId)
    try {
      // Re-use a URL already minted for this link during this session.
      let url = copiedUrlsRef.current.get(linkId)
      if (!url) {
        const { key } = await overseer.newShareLinkKey(linkId)
        url = `${window.location.origin}/workspace/${metadata.id}#share=${key}`
        copiedUrlsRef.current.set(linkId, url)
      }
      const copied = await copyToClipboard(url)
      if (!copied) {
        toasts.add({ title: '共有リンクをコピーできませんでした。', variant: 'error' })
        return
      }
      setCopiedLinkId(linkId)
      showLandedRow('shareLink', linkId)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedLinkId(current => (current === linkId ? null : current))
        copiedTimerRef.current = null
      }, 2000)
      toasts.add({ title: 'リンクがクリップボードにコピーされました。', variant: 'success' })
    } catch (err: any) {
      toasts.add({ title: err.message || '共有リンクをコピーできませんでした。', variant: 'error' })
    } finally {
      copyingLinkRef.current = false
      setCopyingLinkId(null)
    }
  }

  const handleStartRemoveCollaborator = async (profileId: string) => {
    setConfirmationTarget({ kind: 'remove', profileId, dependents: [], previewing: true, keepSet: new Set() })
    try {
      const dependents = await overseer.previewRemoveCollaborator(profileId)
      setConfirmationTarget(current => current?.kind === 'remove' && current.profileId === profileId
        ? { ...current, dependents, previewing: false }
        : current)
    } catch (err: any) {
      setConfirmationTarget(current => current?.kind === 'remove' && current.profileId === profileId ? null : current)
      toasts.add({ title: err.message || '共同編集者の削除をプレビューできませんでした。', variant: 'error' })
    }
  }

  const handleConfirmRemoveCollaborator = async () => {
    if (!removeTarget || removeTarget.previewing || confirmationBusy) return
    setConfirmationBusy(true)
    try {
      const removed = await overseer.removeCollaborator(removeTarget.profileId, [...removeTarget.keepSet])
      setConfirmationTarget(null)
      toasts.add({
        title: removed.length > 0
          ? '協力者が削除されました。'
          : '直接の助成金は削除されました。この共同編集者は、別のソースを通じて引き続きアクセスできます。',
        variant: 'success',
      })
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || '共同作業者の削除に失敗しました。', variant: 'error' })
    } finally {
      setConfirmationBusy(false)
    }
  }

  const startRenameShareLink = (link: ShareLinkInfo) => {
    // Renaming and the destructive confirm are mutually exclusive in-place editors on the same row.
    setConfirmationTarget(null)
    setEditingShareLinkId(link.linkId)
    setEditingShareLinkNote(link.note ?? '')
  }

  const cancelRenameShareLink = () => {
    setEditingShareLinkId(null)
    setEditingShareLinkNote('')
  }

  const handleSaveShareLinkNote = async () => {
    if (!editingShareLinkId || savingShareLinkNoteRef.current) return
    const linkId = editingShareLinkId
    const note = editingShareLinkNote.trim()
    if (note === (shareLinks.find(link => link.linkId === linkId)?.note ?? '')) {
      cancelRenameShareLink()
      return
    }
    savingShareLinkNoteRef.current = true
    setSavingShareLinkNote(true)
    try {
      await overseer.updateShareLink(linkId, note || undefined)
      cancelRenameShareLink()
      await loadData()
      showLandedRow('shareLink', linkId)
      toasts.add({ title: '共有リンクの名前が変更されました。', variant: 'success' })
    } catch (err: any) {
      toasts.add({ title: err.message || '共有リンクの名前を変更できませんでした。', variant: 'error' })
    } finally {
      savingShareLinkNoteRef.current = false
      setSavingShareLinkNote(false)
    }
  }

  const handleStartRevokeShareLink = async (linkId: string) => {
    cancelRenameShareLink()
    setConfirmationTarget({ kind: 'revoke', linkId, dependents: [], previewing: true, keepSet: new Set() })
    try {
      const dependents = await overseer.previewRevokeShareLink(linkId)
      setConfirmationTarget(current => current?.kind === 'revoke' && current.linkId === linkId
        ? { ...current, dependents, previewing: false }
        : current)
    } catch (err: any) {
      setConfirmationTarget(current => current?.kind === 'revoke' && current.linkId === linkId ? null : current)
      toasts.add({ title: err.message || '共有リンクの取り消しをプレビューできませんでした。', variant: 'error' })
    }
  }

  const handleConfirmRevokeShareLink = async () => {
    if (!revokeTarget || revokeTarget.previewing || confirmationBusy) return
    setConfirmationBusy(true)
    try {
      await overseer.revokeShareLink(revokeTarget.linkId, [...revokeTarget.keepSet])
      setConfirmationTarget(null)
      if (revokeTarget.linkId === newShareLinkId) {
        setNewShareLink(null)
        setNewShareLinkId(null)
        setNewShareLinkCopied(false)
        setShowLinkComposer(false)
      }
      toasts.add({ title: '共有リンクが取り消されました。', variant: 'success' })
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || '共有リンクを取り消すことができませんでした。', variant: 'error' })
    } finally {
      setConfirmationBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog
        className="!z-[1000] !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(640px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0 !outline-none"
        size="lg"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 overflow-hidden px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <Dialog.Title className="truncate text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
              「{metadata.title}」を共有
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              人を招待するか、リンクを共有します。
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} aria-label="閉じる">
                <X size={18} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div
          className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 sm:px-6"
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          {sharingProhibited ? (
            <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-kumo-warning-tint text-kumo-warning">
                <ShieldWarning size={22} weight="duotone" />
              </div>
              <p className="mt-3 text-[14px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
                このワークスペースは共有できません
              </p>
              <p className="mt-1.5 max-w-[320px] text-balance text-[12px] leading-[18px] tracking-[-0.1px] text-kumo-subtle">
                所有者であるあなただけがアクセスできる機密データが観察されました。
              </p>
              <p className="mt-2 max-w-[320px] text-balance text-[12px] leading-[18px] tracking-[-0.1px] text-kumo-subtle">
                同様のものを共有するには、このワークスペースのガジェットからブループリントを作成し、それを使用して新しいワークスペースを作成します。
              </p>
            </div>
          ) : (
          <>
          <div className={`sticky top-0 z-10 bg-kumo-base pb-3 transition-shadow duration-200 ${scrolled ? 'themed-bottom-shadow border-b border-kumo-line/60' : ''}`}>
          <div
            className="themed-compact-shadow grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-2xl border border-kumo-line/80 bg-kumo-base p-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-kumo-fill sm:flex sm:overflow-hidden"
            data-keeper-ignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
          >
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
              <UserPlus size={15} weight="duotone" />
            </div>
            <input
              type="search"
              placeholder="ユーザー名またはメールアドレス"
              aria-label="ユーザー名またはメールアドレス"
              value={addUsername}
              onChange={(e) => setAddUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddCollaborator() }}
              name="gadget-share-people-search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              data-keeper-ignore="true"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              className="h-9 min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:hidden"
              disabled={sharingProhibited}
            />
            <RoleMenu
              ariaLabel="付与するアクセス権"
              value={addRole}
              onValueChange={setAddRole}
              disabled={sharingProhibited}
              container={menuContainer}
            />
            <WorkshopButton
              tone="primary"
              className="col-span-3 w-full !rounded-xl sm:col-span-1 sm:w-auto sm:min-w-[68px]"
              onClick={handleAddCollaborator}
              disabled={!addUsername.trim() || adding || sharingProhibited}
            >
              {adding ? '招待中…' : '招待'}
            </WorkshopButton>
          </div>

          {invitedName && (
            <div className="themed-compact-shadow mt-2 flex flex-wrap items-center gap-3 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-2.5 share-fade-in">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
                {invitedLinkCopied ? <Check size={15} weight="bold" /> : <UserPlus size={15} weight="duotone" />}
              </div>
              <div className="min-w-[160px] flex-1">
                <div className="flex items-baseline gap-1.5">
                  <p className="text-[13px] leading-[18px] font-medium text-kumo-default">
                    追加した {invitedName}
                  </p>
                  <span className="text-[11px] leading-4 text-kumo-inactive">
                    {invitedLinkCopied ? 'リンクをクリップボードにコピーしました' : 'このリンクを送って開いてもらいます'}
                  </span>
                </div>
                <p className="truncate font-mono text-[11px] leading-4 text-kumo-subtle">{workspaceUrl}</p>
              </div>
              <WorkshopButton tone="primary" onClick={copyWorkspaceUrl} className="gap-1.5 !rounded-xl">
                {invitedLinkCopied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                {invitedLinkCopied ? 'コピーしました' : 'リンクをコピー'}
              </WorkshopButton>
              <WorkshopIconButton
                aria-label="追加されたコラボレーターを削除する"
                onClick={() => { setInvitedName(null); setInvitedLinkCopied(false) }}
              >
                <X size={14} />
              </WorkshopIconButton>
            </div>
          )}

          <div className="mt-2">
            {(showLinkComposer || newShareLink) ? (
              newShareLink ? (
                <div className="themed-compact-shadow flex flex-wrap items-center gap-3 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-2.5 share-fade-in">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
                      {newShareLinkCopied ? <Check size={15} weight="bold" /> : <Link size={15} />}
                    </div>
                    <div className="min-w-[160px] flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <p className="text-[13px] leading-[18px] font-medium text-kumo-default">
                          {newShareLinkCopied ? 'リンクをコピーしました' : 'リンクを作成しました'}
                        </p>
                        <span className="text-[11px] leading-4 text-kumo-inactive">
                          共有リンクからいつでも再度コピーできます
                        </span>
                      </div>
                      <p className="truncate font-mono text-[11px] leading-4 text-kumo-subtle">{newShareLink}</p>
                    </div>
                    <WorkshopButton tone="primary" onClick={copyNewLink} className="w-[78px] gap-1.5 !rounded-xl">
                      {newShareLinkCopied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                      {newShareLinkCopied ? 'コピーしました' : 'コピー'}
                    </WorkshopButton>
                    <WorkshopIconButton
                      aria-label="作成したリンクを閉じる"
                      onClick={() => { setNewShareLink(null); setNewShareLinkId(null); setNewShareLinkCopied(false); setShowLinkComposer(false) }}
                    >
                      <X size={14} />
                    </WorkshopIconButton>
                </div>
              ) : (
                <div className="themed-compact-shadow flex h-12 items-center gap-2 overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base p-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-kumo-fill share-fade-in">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
                      <Link size={15} />
                    </div>
                    <input
                      ref={linkNameRef}
                      value={newLinkNote}
                      onChange={(e) => setNewLinkNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleCreateShareLink() }}
                      placeholder="このリンクに名前を付けます (オプション)…"
                      aria-label="共有リンク名 (オプション)"
                      className="h-9 min-w-0 flex-1 border-0 bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
                      disabled={creatingLink || sharingProhibited}
                    />
                    <RoleMenu
                      ariaLabel="リンクで付与するアクセス権"
                      value={newLinkRole}
                      onValueChange={setNewLinkRole}
                      disabled={creatingLink || sharingProhibited}
                      container={menuContainer}
                    />
                    <WorkshopButton tone="primary" className="shrink-0 !rounded-xl" onClick={handleCreateShareLink} disabled={creatingLink || sharingProhibited}>
                      {creatingLink ? '作成中…' : 'リンクを作成'}
                    </WorkshopButton>
                    <WorkshopIconButton aria-label="リンクの作成をキャンセルします" onClick={() => setShowLinkComposer(false)}>
                      <X size={14} />
                    </WorkshopIconButton>
                </div>
              )
            ) : (
              <button
                type="button"
                onClick={() => setShowLinkComposer(true)}
                disabled={sharingProhibited}
                className="themed-compact-shadow flex h-12 w-full cursor-pointer items-center justify-center gap-1.5 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 text-[13px] font-medium text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-elevated/60 hover:text-kumo-default active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Link size={14} /> 共有リンクを作成する
              </button>
            )}
          </div>
          </div>

          {recipientVerification}

          <section aria-labelledby="people-heading" className="mt-4">
            <div className="mb-2 px-1">
              <h3 id="people-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
                アクセスできる人
              </h3>
            </div>
            <div className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
              {collaboratorRows.map((row, index) => {
                const profile = row.kind === 'owner' ? row.profile : row.info.profile
                const key = row.kind === 'owner' ? '__owner__' : row.info.profile.id
                const isRemoving = row.kind === 'collaborator' && removeTarget?.profileId === row.info.profile.id
                const downstreamDependents = isRemoving && removeTarget
                  ? removeTarget.dependents.filter(dep => dep.profile.id !== profile.id)
                  : []
                return (
                  <div key={key} className={`group ${index > 0 ? 'border-t border-kumo-line/70' : ''} ${landedPersonId === profile.id ? 'share-row-land' : 'transition-colors duration-150 hover:bg-kumo-elevated/50'} px-3 py-2.5`}>
                    <div className="flex items-center gap-3">
                      <PersonAvatar api={authenticatedApi} userId={profile.id} name={profile.name} size={32} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">
                          {profile.name}{profile.id === currentUser?.id ? '（あなた）' : ''}
                        </p>
                        <p className="truncate text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">
                          {row.kind === 'owner' ? profile.id : describeAccess(row.info)}
                        </p>
                      </div>
                      {row.kind === 'owner' ? (
                        <span className="px-2 text-[12px] text-kumo-subtle">所有者</span>
                      ) : isRemoving ? (
                        <InlineConfirm
                          label="削除"
                          busy={removeTarget.previewing || confirmationBusy}
                          busyLabel={removeTarget.previewing ? '確認中…' : undefined}
                          onConfirm={handleConfirmRemoveCollaborator}
                          onCancel={() => setConfirmationTarget(null)}
                        />
                      ) : (
                        <>
                          <RoleBadge role={row.info.role} />
                          <WorkshopIconButton
                            danger
                            className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() => handleStartRemoveCollaborator(row.info.profile.id)}
                            aria-label={`${profile.name}さんを削除`}
                            disabled={confirmationBusy}
                          >
                            <Trash size={13} />
                          </WorkshopIconButton>
                        </>
                      )}
                    </div>
                    {isRemoving && downstreamDependents.length > 0 && (
                      <div className="mt-2.5 share-expand-in">
                        <p className="mb-1.5 text-[12px] leading-4 text-kumo-subtle">
                          {profile.name}さんを削除すると、ほかの{downstreamDependents.length}人もアクセスできなくなります。アクセスを維持する人を選択してください。
                        </p>
                        <DependentKeepList
                          dependents={downstreamDependents}
                          keepSet={removeTarget.keepSet}
                          onKeepSetChange={(keepSet) => setConfirmationTarget(current =>
                            current?.kind === 'remove' && current.profileId === removeTarget.profileId
                              ? { ...current, keepSet }
                              : current
                          )}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          {shareLinks.length > 0 && (
          <section aria-labelledby="links-heading" className="mt-4">
            <div className="mb-2 px-1">
              <h3 id="links-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
                リンクを共有する
              </h3>
            </div>

              <div className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
                {sortedShareLinks.map((sk, index) => {
                  const isRevoking = revokeTarget?.linkId === sk.linkId
                  const isRenaming = editingShareLinkId === sk.linkId
                  return (
                    <div key={sk.linkId} className={`group ${index > 0 ? 'border-t border-kumo-line/70' : ''} ${landedShareLinkId === sk.linkId ? 'share-row-land' : 'transition-colors duration-150 hover:bg-kumo-elevated/50'} px-3 py-2.5`}>
                      <div className="flex items-center gap-3">
                        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-kumo-tint to-kumo-elevated text-kumo-subtle ring-1 ring-inset ring-kumo-line/60">
                          <Link size={14} />
                        </div>
                        <div className="min-w-0 flex-1">
                          {isRenaming ? (
                            <input
                              ref={renameInputRef}
                              value={editingShareLinkNote}
                              onChange={(e) => setEditingShareLinkNote(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveShareLinkNote()
                                if (e.key === 'Escape') cancelRenameShareLink()
                              }}
                              placeholder="このリンクに名前を付けます…"
                              aria-label="共有リンク名"
                              className="block w-full border-0 bg-transparent p-0 text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default outline-none shadow-[inset_0_-1px_0_0_var(--color-kumo-line)] transition-shadow placeholder:font-normal placeholder:text-kumo-inactive focus:shadow-[inset_0_-1px_0_0_var(--color-kumo-fill)]"
                              disabled={savingShareLinkNote}
                            />
                          ) : (
                            <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">{sk.note || '無題のリンク'}</p>
                          )}
                          <p className="truncate text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">作成者 {sk.createdBy.name} · {formatRelativeTime(sk.created)}</p>
                        </div>
                        {isRenaming ? (
                          <InlineConfirm
                            label="保存"
                            tone="brand"
                            busy={savingShareLinkNote}
                            onConfirm={handleSaveShareLinkNote}
                            onCancel={cancelRenameShareLink}
                          />
                        ) : isRevoking ? (
                          <InlineConfirm
                            label="取り消す"
                            busy={revokeTarget.previewing || confirmationBusy}
                            busyLabel={revokeTarget.previewing ? 'Checking…' : undefined}
                            onConfirm={handleConfirmRevokeShareLink}
                            onCancel={() => setConfirmationTarget(null)}
                          />
                        ) : (
                          <>
                            <RoleBadge role={sk.role} />
                            <WorkshopIconButton
                              className="!h-7 !w-7"
                              onClick={() => handleCopyShareLink(sk.linkId)}
                              aria-label={`${sk.note || '共有リンク'}をコピー`}
                              disabled={confirmationBusy || copyingLinkId === sk.linkId || sharingProhibited}
                            >
                              {copiedLinkId === sk.linkId ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                            </WorkshopIconButton>
                            <WorkshopIconButton
                              className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => startRenameShareLink(sk)}
                              aria-label={`${sk.note || '共有リンク'}の名前を変更`}
                              disabled={confirmationBusy}
                            >
                              <PencilSimple size={13} />
                            </WorkshopIconButton>
                            <WorkshopIconButton
                              danger
                              className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => handleStartRevokeShareLink(sk.linkId)}
                              aria-label={`${sk.note || '共有リンク'}を取り消す`}
                              disabled={confirmationBusy}
                            >
                              <Trash size={13} />
                            </WorkshopIconButton>
                          </>
                        )}
                      </div>
                      {isRevoking && revokeTarget.dependents.length > 0 && (
                        <div className="mt-2.5 share-expand-in">
                          <p className="mb-1.5 text-[12px] leading-4 text-kumo-subtle">
                            このリンクを取り消すと、{revokeTarget.dependents.length}人がアクセスできなくなります。アクセスを維持する人を選択してください。
                          </p>
                          <DependentKeepList
                            dependents={revokeTarget.dependents}
                            keepSet={revokeTarget.keepSet}
                            onKeepSetChange={(keepSet) => setConfirmationTarget(current =>
                              current?.kind === 'revoke' && current.linkId === revokeTarget.linkId
                                ? { ...current, keepSet }
                                : current
                            )}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
          </section>
          )}
          </>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
