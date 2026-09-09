import { t, useTranslation } from "@gadgets/i18n";
import { Lock, MagnifyingGlass, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useId, useRef } from 'react'
import {
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './WorkshopControls'

export type WorkspaceOpenFailureKind = 'access-denied' | 'not-found' | 'unexpected'

const CONTENT = {
  'access-denied': {
    get title() { return t("workshop-frontend.WorkspaceOpenErrorPage.you_don_t_have_access_to_this_workspace"); },
    get message() { return t("workshop-frontend.WorkspaceOpenErrorPage.ask_the_workspace_owner_to_grant_you_access_then_try_again"); },
    Icon: Lock,
    retryable: true,
  },
  'not-found': {
    get title() { return t("workshop-frontend.WorkspaceOpenErrorPage.workspace_not_found"); },
    get message() { return t("workshop-frontend.WorkspaceOpenErrorPage.the_link_may_be_incorrect_or_the_workspace_may_have_been_deleted"); },
    Icon: MagnifyingGlass,
    retryable: false,
  },
  unexpected: {
    get title() { return t("workshop-frontend.WorkspaceOpenErrorPage.we_couldn_t_load_this_workspace"); },
    get message() { return t("workshop-frontend.WorkspaceOpenErrorPage.try_again_if_the_problem_continues_return_to_your_workspaces"); },
    Icon: WarningCircle,
    retryable: true,
  },
} as const

export function classifyWorkspaceOpenFailure(error: unknown): WorkspaceOpenFailureKind {
  switch (getOpenGadgetErrorCode(error)) {
    case OPEN_GADGET_ERROR_CODES.workspaceAccessDenied:
      return 'access-denied'
    case OPEN_GADGET_ERROR_CODES.workspaceNotFound:
      return 'not-found'
    default:
      return 'unexpected'
  }
}

type Props = {
  kind: WorkspaceOpenFailureKind
  onRetry: () => void
  onGoToWorkspaces: () => void
}

export default function WorkspaceOpenErrorPage({ kind, onRetry, onGoToWorkspaces }: Props) {
  const { t } = useTranslation();
  const { title, message, Icon, retryable } = CONTENT[kind]
  const titleId = useId()
  const descriptionId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  return (
    <div className="flex min-h-full items-center justify-center bg-kumo-base px-6 py-12">
      <section
        aria-atomic="true"
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-live="polite"
        className="themed-compact-shadow w-full max-w-md rounded-2xl border border-kumo-line bg-kumo-base px-6 py-8 text-center"
      >
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-kumo-line bg-kumo-tint text-kumo-subtle">
          <Icon aria-hidden="true" size={20} weight="bold" />
        </div>
        <h1
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="mt-5 text-[20px] leading-7 font-semibold tracking-[-0.35px] text-kumo-default outline-none"
        >
          {title}
        </h1>
        <p
          id={descriptionId}
          className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle"
        >
          {message}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <WorkshopButton
            tone={retryable ? 'secondary' : 'primary'}
            className="!h-9"
            onClick={onGoToWorkspaces}
          >
            {t("workshop-frontend.GadgetEditor.go_to_workspaces")}</WorkshopButton>
          {retryable && (
            <WorkshopButton tone="primary" onClick={onRetry}>
              {t("gatekeeper-scheduler.SchedulerPage.try_again")}</WorkshopButton>
          )}
        </div>
      </section>
    </div>
  )
}
