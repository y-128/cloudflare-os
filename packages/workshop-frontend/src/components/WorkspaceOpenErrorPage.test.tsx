import { t, setLocale } from "@gadgets/i18n";
// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenGadgetError, OPEN_GADGET_ERROR_CODES } from '@gadgets/workshop-shared/api'
import WorkspaceOpenErrorPage, { classifyWorkspaceOpenFailure } from './WorkspaceOpenErrorPage'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('./WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

describe('WorkspaceOpenErrorPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    setLocale("ja")
  })

  async function render(kind: 'access-denied' | 'not-found' | 'unexpected') {
    const onRetry = vi.fn<() => void>()
    const onGoToWorkspaces = vi.fn<() => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <WorkspaceOpenErrorPage
        kind={kind}
        onRetry={onRetry}
        onGoToWorkspaces={onGoToWorkspaces}
      />,
    ))
    return { container, onGoToWorkspaces, onRetry }
  }

  it('updates module-defined headings when the language changes without remounting', async () => {
    setLocale('ja')
    const { container } = await render('access-denied')
    const heading = container.querySelector('h1')!
    expect(heading.textContent).toBe(t('workshop-frontend.WorkspaceOpenErrorPage.you_don_t_have_access_to_this_workspace'))
    await act(async () => setLocale('en'))
    expect(container.querySelector('h1')).toBe(heading)
    expect(heading.textContent).toBe(t('workshop-frontend.WorkspaceOpenErrorPage.you_don_t_have_access_to_this_workspace'))
    expect(heading.textContent).not.toContain('[missing:')
  })

  it('explains how to recover when access is denied without exposing workspace metadata', async () => {
    const { container: renderedContainer, onGoToWorkspaces, onRetry } = await render('access-denied')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe(t("workshop-frontend.WorkspaceOpenErrorPage.you_don_t_have_access_to_this_workspace"))
    expect(renderedContainer.textContent).toContain(t("workshop-frontend.WorkspaceOpenErrorPage.ask_the_workspace_owner_to_grant_you_access_then_try_again"))
    expect(document.activeElement).toBe(renderedContainer.querySelector('h1'))

    const buttons = [...renderedContainer.querySelectorAll('button')]
    expect(buttons.map(button => button.textContent)).toEqual([t("workshop-frontend.GadgetEditor.go_to_workspaces"), t("gatekeeper-scheduler.SchedulerPage.try_again")])
    act(() => buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onGoToWorkspaces).toHaveBeenCalledOnce()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('gives a missing workspace a distinct, non-retryable state', async () => {
    const { container: renderedContainer } = await render('not-found')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe(t("workshop-frontend.WorkspaceOpenErrorPage.workspace_not_found"))
    expect(renderedContainer.textContent).toContain(t("workshop-frontend.WorkspaceOpenErrorPage.the_link_may_be_incorrect_or_the_workspace_may_have_been_deleted"))
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual([t("workshop-frontend.GadgetEditor.go_to_workspaces")])
  })

  it('keeps unexpected failures retryable', async () => {
    const { container: renderedContainer } = await render('unexpected')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe(t("workshop-frontend.WorkspaceOpenErrorPage.we_couldn_t_load_this_workspace"))
    expect(renderedContainer.textContent).toContain(t("workshop-frontend.WorkspaceOpenErrorPage.try_again_if_the_problem_continues_return_to_your_workspaces"))
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual([t("workshop-frontend.GadgetEditor.go_to_workspaces"), t("gatekeeper-scheduler.SchedulerPage.try_again")])
  })

  it('classifies stable open error codes without treating unexpected errors as expected', () => {
    expect(classifyWorkspaceOpenFailure(
      createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
    )).toBe('access-denied')
    expect(classifyWorkspaceOpenFailure(
      createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound),
    )).toBe('not-found')
    expect(classifyWorkspaceOpenFailure(
      new Error(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
    )).toBe('unexpected')
    expect(classifyWorkspaceOpenFailure(new Error('storage unavailable'))).toBe('unexpected')
  })
})
