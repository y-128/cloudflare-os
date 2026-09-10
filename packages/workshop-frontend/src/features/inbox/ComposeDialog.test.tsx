// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRootRoute, createRoute, createRouter, RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import { ComposeDialog } from './ComposeDialog'
import type { ComposeSession, Email } from './types'
import type { MailTemplate } from './mailTemplates'
import type { ScheduledSend } from './ScheduledSends'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Exercise persistence independently of Tiptap layout; the browser check covers the real editor.
vi.mock('./RichTextEditor', () => ({ RichTextEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label={t('workshop-frontend.Inbox.body')} value={value} onChange={event => onChange(event.target.value)} /> }))
let root: Root
let container: HTMLDivElement
const close = vi.fn<() => void>()
const saved = vi.fn<() => void>()

beforeEach(() => {
  setLocale('en'); vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Mounts compose inside the router required by its unsaved-navigation guard. */
const render = async (session: ComposeSession) => {
  /** Reflects the parent's close lifecycle so discarded dialogs release their navigation blocker. */
  const Host = () => {
    const [open, setOpen] = useState(true)
    return open ? <ComposeDialog mailboxId="me@example.com" session={session} onClose={() => { close(); setOpen(false) }} onSaved={saved} /> : null
  }
  const route = createRootRoute({ component: Host })
  const home = createRoute({ getParentRoute: () => route, path: '/' })
  const other = createRoute({ getParentRoute: () => route, path: '/explore' })
  const router = createRouter({ routeTree: route.addChildren([home, other]), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load(); await act(async () => root.render(<RouterProvider router={router} />))
  return router
}

/** Types through the native setter so React observes the textarea input event. */
const typeBody = async (value: string) => {
  await act(async () => {
    const field = document.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Clicks a translated action rendered in the dialog portal. */
const click = async (text: string) => {
  const button = [...document.querySelectorAll('button')].find(element => element.textContent === text)
  if (!button) throw new Error(`Missing button ${text}`)
  await act(async () => button.click())
}

it('serializes autosaves and flushes the latest edit before closing with the previous saved ID', async () => {
  const drafts: { body: string; draft_id?: string }[] = []
  let finishFirst!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    if (String(_url).endsWith('/mailbox-settings')) return Response.json({ fromName: '' })
    if (String(_url).endsWith('/templates')) return Response.json([])
    drafts.push(JSON.parse(String(init?.body)))
    if (drafts.length === 1) return new Promise(resolve => { finishFirst = resolve })
    return Response.json({ id: 'draft-2' })
  }))
  await render({ key: 'new', mode: 'new' })
  await typeBody('<p>First edit</p>')
  await act(async () => { await vi.waitFor(() => expect(drafts).toHaveLength(1), { timeout: 2000 }) })
  await typeBody('<p>Latest edit</p>')
  await click(t('workshop-frontend.Inbox.close'))
  expect(close).not.toHaveBeenCalled()
  expect(drafts).toHaveLength(1)
  await act(async () => { finishFirst(Response.json({ id: 'draft-1' })); await Promise.resolve() })
  expect(drafts).toEqual([{ from: 'me@example.com', to: '', cc: '', bcc: '', subject: '', body: '<p>First edit</p>', attachments: [] }, { from: 'me@example.com', to: '', cc: '', bcc: '', subject: '', body: '<p>Latest edit</p>', attachments: [], draft_id: 'draft-1' }])
  expect(close).toHaveBeenCalledOnce()
})

it('keeps a failed draft save open with the latest text and allows explicit retry', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('', { status: 500 }))
  vi.stubGlobal('fetch', fetch)
  await render({ key: 'new', mode: 'new' })
  await typeBody('<p>Keep my draft</p>')
  await click(t('workshop-frontend.Inbox.close'))
  expect(close).not.toHaveBeenCalled()
  expect(document.querySelector('textarea')?.value).toBe('<p>Keep my draft</p>')
  expect([...document.querySelectorAll('[role="alert"]')].some(element => element.textContent?.includes(t('workshop-frontend.Inbox.save_failed')))).toBe(true)
  fetch.mockResolvedValue(Response.json({ id: 'recovered' }))
  await click(t('workshop-frontend.Inbox.close'))
  expect(close).toHaveBeenCalledOnce()
})

/** Clears a controlled recipient or subject through its native setter. */
const clearField = async (field: HTMLInputElement) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('persists clearing every field of an existing draft on close', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => /\/(templates|scheduled-sends)$/.test(String(url)) ? Response.json([]) : Response.json({ id: 'empty-draft' }))
  vi.stubGlobal('fetch', fetch)
  const original: Email = { id: 'saved-draft', recipient: 'to@example.com', cc: 'cc@example.com', bcc: 'bcc@example.com', subject: 'Old subject', body: '<p>Old body</p>', sender: 'me@example.com', date: '', read: true, starred: false }
  await render({ key: 'existing', mode: 'draft', original })
  for (const field of document.querySelectorAll<HTMLInputElement>('fieldset input')) {
    if (field.type !== 'file') await clearField(field)
  }
  await typeBody('')
  await click(t('workshop-frontend.Inbox.close'))
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'POST')![1]?.body))).toMatchObject({ draft_id: 'saved-draft', to: '', cc: '', bcc: '', subject: '', body: '' })
  expect(close).toHaveBeenCalledOnce()
})

it('does not create an empty new draft after typing and clearing it', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ fromName: '' }))
  vi.stubGlobal('fetch', fetch)
  await render({ key: 'empty', mode: 'new' })
  await typeBody('<p>Temporary</p>')
  await typeBody('')
  await click(t('workshop-frontend.Inbox.close'))
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  expect(close).toHaveBeenCalledOnce()
})

it('explains unsaved loss and allows closing without another save after persistent failures', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('', { status: 503 }))
  vi.stubGlobal('fetch', fetch)
  await render({ key: 'offline', mode: 'new' })
  await typeBody('<p>Unsaved work</p>')
  await click(t('workshop-frontend.Inbox.close'))
  expect(close).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.discard_hint'))
  const attempts = fetch.mock.calls.length
  await click(t('workshop-frontend.Inbox.close_without_saving'))
  expect(close).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledTimes(attempts)
})

it('releases failed navigation after the user explicitly discards unsaved edits', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 503 })))
  const router = await render({ key: 'blocked', mode: 'new' })
  await typeBody('<p>Unsaved work</p>')
  await act(async () => { void router.navigate({ to: '/explore' }); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(router.state.location.pathname).toBe('/')
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.discard_hint'))
  await click(t('workshop-frontend.Inbox.close_without_saving'))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { await router.navigate({ to: '/explore' }) })
  expect(router.state.location.pathname).toBe('/explore')
})

it.each(['山田 "営業, Tokyo"', ''])('shows the saved display name with the address, or just the address: %s', async fromName => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ fromName })))
  await render({ key: 'sender', mode: 'new' })
  const expected = fromName ? `${fromName} <me@example.com>` : 'me@example.com'
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(`${t('workshop-frontend.Inbox.from')}: ${expected}`)
})

it('retries the sender resource without losing compose input', async () => {
  let fail = true
  const fetch = vi.fn<typeof globalThis.fetch>(async url => {
    if (String(url).endsWith('/mailbox-settings')) return fail ? new Response('', { status: 503 }) : Response.json({ fromName: 'Recovered sender' })
    return Response.json({ id: 'draft' })
  })
  vi.stubGlobal('fetch', fetch)
  await render({ key: 'sender-retry', mode: 'new' })
  await typeBody('Keep this content')
  fail = false
  await click(t('workshop-frontend.Inbox.retry'))
  expect(document.querySelector('textarea')?.value).toBe('Keep this content')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Recovered sender <me@example.com>')
})

/** Drives labelled Kumo inputs without depending on generated field IDs. */
const typeField = async (key: string, value: string) => {
  const label = [...document.querySelectorAll('label')].find(element => element.textContent === t(`workshop-frontend.Inbox.${key}`))!
  const field = document.getElementById(label.htmlFor) as HTMLInputElement | HTMLTextAreaElement
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const extrasFixture = (options: { failDraft?: boolean; failSchedule?: boolean; failTemplates?: boolean; failCancel?: boolean } = {}) => {
  const templates: MailTemplate[] = [{ id: 'template/1', name: 'Greeting', shortcut: '/hello', subject: 'For {{recipient_name}}', body: 'Hello {{recipient_name}}\n{{sender_name}} {{date}} {{unknown}}' }]
  const scheduled: ScheduledSend[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = String(url)
    if (path.endsWith('/mailbox-settings')) return Response.json({ fromName: 'Saved sender' })
    if (path.endsWith('/drafts')) return options.failDraft ? new Response('', { status: 503 }) : Response.json({ id: 'latest-draft' })
    if (path.endsWith('/templates')) {
      if (options.failTemplates) return new Response('', { status: 503 })
      if (init?.method === 'PUT') {
        const template = JSON.parse(String(init.body)) as MailTemplate
        const index = templates.findIndex(item => item.id === template.id)
        if (index < 0) templates.push({ ...template, id: 'new-template' })
        else templates[index] = template
        return Response.json({ id: template.id || 'new-template' })
      }
      return Response.json(templates)
    }
    if (path.includes('/templates/') && init?.method === 'DELETE') { templates.splice(templates.findIndex(item => encodeURIComponent(item.id) === path.split('/').at(-1)), 1); return new Response(null, { status: 204 }) }
    if (path.endsWith('/scheduled-sends')) {
      if (init?.method === 'POST') {
        if (options.failSchedule) throw new TypeError('Network disconnected')
        scheduled.push({ ...JSON.parse(String(init.body)), id: 'schedule/1', status: 'pending' })
        return Response.json({ id: 'schedule/1' })
      }
      return Response.json(scheduled)
    }
    if (path.includes('/scheduled-sends/') && init?.method === 'DELETE') {
      if (options.failCancel) return new Response('', { status: 503 })
      scheduled.splice(0); return new Response(null, { status: 204 })
    }
    if (path.includes('/emails/')) return Response.json({ id: decodeURIComponent(path.split('/').at(-1)!), folder_id: 'draft', subject: 'Reserved subject', recipient: 'friend@example.com' })
    return Response.json({})
  })
  vi.stubGlobal('fetch', fetch)
  return { fetch, templates, scheduled, options }
}

const fillMessage = async () => {
  await typeField('to', 'Friend <friend@example.com>')
  await typeField('subject', 'Reserved subject')
  await typeBody('<p>Latest message</p>')
}

it('saves the latest draft before scheduling in UTC, lists it, cancels it, and never sends or deletes the draft', async () => {
  const { fetch } = extrasFixture()
  await render({ key: 'schedule', mode: 'new' })
  await fillMessage()
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2099-01-02T12:30')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(writes.map(([url]) => String(url).split('/').at(-1))).toEqual(['drafts', 'scheduled-sends'])
  expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ body: '<p>Latest message</p>' })
  expect(JSON.parse(String(writes[1][1]?.body))).toEqual({ draft_email_id: 'latest-draft', send_at: new Date('2099-01-02T12:30').toISOString() })
  expect(document.body.textContent).toContain('Reserved subject')
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.schedule_status_pending'))
  expect([...document.querySelectorAll('button')].find(button => button.textContent === t('workshop-frontend.Inbox.send'))?.disabled).toBe(true)
  await click(t('workshop-frontend.Inbox.cancel_schedule'))
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.no_scheduled_sends'))
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => String(url))).toEqual(['/api/inbox/v1/mailboxes/me%40example.com/scheduled-sends/schedule%2F1'])
  await click(t('workshop-frontend.Inbox.close'))
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
})

it('rejects past times without writing a schedule and retains the draft if saving fails', async () => {
  const fixture = extrasFixture({ failDraft: true })
  await render({ key: 'schedule-failure', mode: 'new' })
  await fillMessage()
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2000-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.schedule_future_required'))
  await typeField('schedule_datetime', '2099-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  expect(fixture.fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/scheduled-sends') && init?.method === 'POST')).toHaveLength(0)
  expect(document.querySelector('textarea')?.value).toBe('<p>Latest message</p>')
  expect(close).not.toHaveBeenCalled()
  fixture.options.failDraft = false
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.schedule_created'))
})

it('freezes the draft after an ambiguous scheduling failure instead of silently retrying', async () => {
  const { fetch } = extrasFixture({ failSchedule: true })
  await render({ key: 'schedule-uncertain', mode: 'new' })
  await fillMessage()
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2099-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.schedule_uncertain'))
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  expect(fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/scheduled-sends') && init?.method === 'POST')).toHaveLength(1)
})

it('locks a reopened reserved draft until cancellation succeeds and retains failed cancellations for retry', async () => {
  const fixture = extrasFixture({ failCancel: true })
  fixture.scheduled.push({ id: 'schedule/1', draft_email_id: 'reserved', send_at: '2099-01-01T00:00:00.000Z', status: 'pending' })
  await render({ key: 'reserved', mode: 'draft', original: { id: 'reserved', subject: 'Reserved', body: '<p>Body</p>', sender: 'me@example.com', recipient: 'friend@example.com', date: '', read: true, starred: false } })
  expect(document.querySelector('fieldset')?.disabled).toBe(true)
  await click(t('workshop-frontend.Inbox.scheduled_sends'))
  await click(t('workshop-frontend.Inbox.cancel_schedule'))
  expect(document.querySelector('fieldset')?.disabled).toBe(true)
  fixture.options.failCancel = false
  await click(t('workshop-frontend.Inbox.cancel_schedule'))
  expect(document.querySelector('fieldset')?.disabled).toBe(false)
})

it('inserts expanded templates using the saved sender name and preserves the existing subject and body', async () => {
  extrasFixture()
  await render({ key: 'template-insert', mode: 'new' })
  await fillMessage()
  await click(t('workshop-frontend.Inbox.templates'))
  await click(t('workshop-frontend.Inbox.insert_template'))
  const body = document.querySelector('textarea')?.value
  expect(body).toContain('<p>Latest message</p>')
  expect(body).toContain('Hello Friend<br>Saved sender')
  expect(body).toContain(new Date().toLocaleDateString('en'))
  expect(body).toContain('{{unknown}}')
  await click(t('workshop-frontend.Inbox.close'))
})

it('creates, edits and deletes templates through the existing endpoints', async () => {
  const fixture = extrasFixture()
  await render({ key: 'template-crud', mode: 'new' })
  await click(t('workshop-frontend.Inbox.templates'))
  await typeField('template_name', 'Follow up')
  await typeField('template_shortcut', '/follow')
  await typeField('template_subject', 'Subject')
  await typeField('template_body', 'Body {{sender_name}}')
  await click(t('workshop-frontend.Inbox.save_template'))
  expect(fixture.templates[1]).toMatchObject({ name: 'Follow up', shortcut: '/follow', subject: 'Subject', body: 'Body {{sender_name}}' })
  const edit = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('workshop-frontend.Inbox.edit_template_named', { name: 'Follow up' })}"]`)!
  await act(async () => edit.click())
  await typeField('template_body', 'Changed')
  await click(t('workshop-frontend.Inbox.save_template'))
  expect(fixture.templates[1].body).toBe('Changed')
  const remove = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('workshop-frontend.Inbox.delete_template_named', { name: 'Greeting' })}"]`)!
  await act(async () => remove.click())
  expect(fixture.templates.map(item => item.name)).toEqual(['Follow up'])
  expect(fixture.fetch.mock.calls.some(([url, init]) => String(url).endsWith('/templates/template%2F1') && init?.method === 'DELETE')).toBe(true)
})

it('retries template loading and retains unsaved template edits after mutation errors', async () => {
  const fixture = extrasFixture({ failTemplates: true })
  await render({ key: 'template-retry', mode: 'new' })
  await click(t('workshop-frontend.Inbox.templates'))
  fixture.options.failTemplates = false
  await click(t('workshop-frontend.Inbox.retry'))
  expect(document.body.textContent).toContain('Greeting')
  await typeField('template_name', 'Retain this name')
  fixture.options.failTemplates = true
  await click(t('workshop-frontend.Inbox.save_template'))
  expect([...document.querySelectorAll('input')].some(input => input.value === 'Retain this name')).toBe(true)
  fixture.options.failTemplates = false
  await click(t('workshop-frontend.Inbox.save_template'))
  expect(fixture.templates.some(item => item.name === 'Retain this name')).toBe(true)
})

it('waits for an in-flight autosave and schedules only the newest queued draft ID', async () => {
  const fixture = extrasFixture()
  const serve = fixture.fetch.getMockImplementation()!
  let finishFirst!: (response: Response) => void
  let draftWrites = 0
  fixture.fetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/drafts') && ++draftWrites === 1) return new Promise(resolve => { finishFirst = resolve })
    return serve(url, init)
  })
  await render({ key: 'schedule-queue', mode: 'new' })
  await fillMessage()
  await act(async () => { await vi.waitFor(() => expect(draftWrites).toBe(1), { timeout: 2000 }) })
  await typeBody('<p>Edited during autosave</p>')
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2099-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  expect(fixture.scheduled).toHaveLength(0)
  await act(async () => { finishFirst(Response.json({ id: 'first-draft' })); await Promise.resolve() })
  const drafts = fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/drafts'))
  expect(JSON.parse(String(drafts[1][1]?.body))).toMatchObject({ draft_id: 'first-draft', body: '<p>Edited during autosave</p>' })
  expect(fixture.scheduled[0].draft_email_id).toBe('latest-draft')
})

it('restores attachments before scheduling an existing draft and saves their bytes with the new ID', async () => {
  const fixture = extrasFixture()
  const serve = fixture.fetch.getMockImplementation()!
  let finishAttachment!: (response: Response) => void
  fixture.fetch.mockImplementation(async (url, init) => String(url).includes('/attachments/') ? new Promise(resolve => { finishAttachment = resolve }) : serve(url, init))
  await render({ key: 'schedule-attachments', mode: 'draft', original: { id: 'old-draft', subject: 'Files', body: '<p>Attached</p>', sender: 'me@example.com', recipient: 'friend@example.com', date: '', read: true, starred: false, attachments: [{ id: 'file', filename: 'notes.txt', mimetype: 'text/plain', size: 5 }] } })
  expect([...document.querySelectorAll('button')].find(button => button.textContent === t('workshop-frontend.Inbox.schedule_send'))?.disabled).toBe(true)
  await act(async () => { finishAttachment(new Response('hello')); await Promise.resolve() })
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2099-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  const draft = fixture.fetch.mock.calls.find(([url]) => String(url).endsWith('/drafts'))!
  expect(JSON.parse(String(draft[1]?.body))).toMatchObject({ draft_id: 'old-draft', attachments: [{ filename: 'notes.txt', content: 'aGVsbG8=', type: 'text/plain', disposition: 'attachment' }] })
  expect(fixture.scheduled[0].draft_email_id).toBe('latest-draft')
})

it('silences aborted scheduling and template reads without logging AbortError', async () => {
  const fixture = extrasFixture()
  const serve = fixture.fetch.getMockImplementation()!
  fixture.fetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/templates') || (String(url).endsWith('/scheduled-sends') && init?.method === 'POST')) throw new DOMException('Aborted', 'AbortError')
    return serve(url, init)
  })
  await render({ key: 'abort', mode: 'new' })
  await fillMessage()
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2099-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  expect(console.error).not.toHaveBeenCalled()
})


it('unlocks a newly scheduled draft after cancellation and saves subsequent edits', async () => {
  const fixture = extrasFixture()
  await render({ key: 'cancel-new-reservation', mode: 'new' })
  await fillMessage()
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2099-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  expect(document.querySelector('fieldset')?.disabled).toBe(true)
  await click(t('workshop-frontend.Inbox.cancel_schedule'))
  expect(document.querySelector('fieldset')?.disabled).toBe(false)
  await typeBody('<p>Edited after cancellation</p>')
  await click(t('workshop-frontend.Inbox.close'))
  const drafts = fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/drafts'))
  expect(JSON.parse(String(drafts.at(-1)![1]?.body))).toMatchObject({ draft_id: 'latest-draft', body: '<p>Edited after cancellation</p>' })
})


it.each(['sent', 'trash'])('keeps a cancelled reservation locked when the email is now in %s', async folder => {
  const fixture = extrasFixture()
  const serve = fixture.fetch.getMockImplementation()!
  fixture.fetch.mockImplementation(async (url, init) => String(url).includes('/emails/') ? Response.json({ id: 'latest-draft', folder_id: folder }) : serve(url, init))
  await render({ key: 'cancel-no-longer-draft', mode: 'new' })
  await fillMessage()
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2099-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  await click(t('workshop-frontend.Inbox.cancel_schedule'))
  expect(document.querySelector('fieldset')?.disabled).toBe(true)
  expect([...document.querySelectorAll('button')].find(button => button.textContent === t('workshop-frontend.Inbox.send'))?.disabled).toBe(true)
})

it('keeps editing locked during verification, then retries the failed draft read without cancelling twice', async () => {
  const fixture = extrasFixture()
  const serve = fixture.fetch.getMockImplementation()!
  let finishRead!: (response: Response) => void
  await render({ key: 'cancel-verification-retry', mode: 'new' })
  await fillMessage()
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2099-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  fixture.fetch.mockImplementation(async (url, init) => String(url).includes('/emails/') ? new Promise(resolve => { finishRead = resolve }) : serve(url, init))
  await click(t('workshop-frontend.Inbox.cancel_schedule'))
  expect(document.querySelector('fieldset')?.disabled).toBe(true)
  await act(async () => finishRead(new Response('', { status: 503 })))
  expect(document.querySelector('fieldset')?.disabled).toBe(true)
  fixture.fetch.mockImplementation(serve)
  await click(t('workshop-frontend.Inbox.retry'))
  expect(document.querySelector('fieldset')?.disabled).toBe(false)
  expect(fixture.fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1)
})

it('does not unlock a sent compose when another reservation is cancelled after draft cleanup fails', async () => {
  const fixture = extrasFixture()
  const serve = fixture.fetch.getMockImplementation()!
  fixture.fetch.mockImplementation(async (url, init) => String(url).includes('/emails/') && init?.method === 'DELETE' ? new Response('', { status: 503 }) : serve(url, init))
  fixture.scheduled.push({ id: 'other', draft_email_id: 'other-draft', send_at: '2099-01-01T00:00:00Z', status: 'pending' })
  await render({ key: 'sent-locked', mode: 'draft', original: { id: 'sent-draft', subject: 'Sent', body: 'Body', sender: 'me@example.com', recipient: 'friend@example.com', date: '', read: true, starred: false, folder_id: 'draft' } })
  await click(t('workshop-frontend.Inbox.send'))
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.sent_cleanup_failed'))
  await click(t('workshop-frontend.Inbox.scheduled_sends'))
  await click(t('workshop-frontend.Inbox.cancel_schedule'))
  expect(document.querySelector('fieldset')?.disabled).toBe(true)
  expect(fixture.fetch.mock.calls.filter(([url]) => String(url).endsWith('/emails'))).toHaveLength(1)
})


it('requires a fresh draft check when the same unchanged draft is scheduled and cancelled again', async () => {
  const fixture = extrasFixture()
  const serve = fixture.fetch.getMockImplementation()!
  await render({ key: 'repeat-reservation', mode: 'new' })
  await fillMessage()
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2099-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  await click(t('workshop-frontend.Inbox.cancel_schedule'))
  expect(document.querySelector('fieldset')?.disabled).toBe(false)
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  let finishRead!: (response: Response) => void
  fixture.fetch.mockImplementation(async (url, init) => String(url).includes('/emails/') ? new Promise(resolve => { finishRead = resolve }) : serve(url, init))
  await click(t('workshop-frontend.Inbox.cancel_schedule'))
  expect(document.querySelector('fieldset')?.disabled).toBe(true)
  await act(async () => finishRead(Response.json({ id: 'latest-draft', folder_id: 'sent' })))
  expect(document.querySelector('fieldset')?.disabled).toBe(true)
})


it('does not reuse a previous cancellation check after an ambiguous rescheduling failure', async () => {
  const fixture = extrasFixture()
  await render({ key: 'repeat-reservation-failure', mode: 'new' })
  await fillMessage()
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await typeField('schedule_datetime', '2099-01-01T00:00')
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  await click(t('workshop-frontend.Inbox.cancel_schedule'))
  fixture.options.failSchedule = true
  await click(t('workshop-frontend.Inbox.schedule_send'))
  await click(t('workshop-frontend.Inbox.confirm_schedule'))
  expect(document.querySelector('fieldset')?.disabled).toBe(true)
  expect(document.body.textContent).toContain(t('workshop-frontend.Inbox.schedule_uncertain'))
})
