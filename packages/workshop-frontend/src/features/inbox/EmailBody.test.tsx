// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setLocale, t } from '@gadgets/i18n'
import { EmailBody, emailDocument } from './EmailBody'
import { emailBodyType, initialComposeFields, plainText } from './mailLogic'
import type { Email } from './types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  setLocale('ja')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

it('opens only verified mail destinations through host links while keeping the frame fully sandboxed', async () => {
  await act(async () => root.render(<EmailBody body={'<a href="https://example.com/path" target="_self">Visit</a><a href="http://example.org/">Other</a><a href="javascript:alert(1)">Bad</a><a href="https://name:secret@example.com">Credentials</a><a href="//relative.example/">Relative</a>'} />))
  const links = [...container.querySelectorAll('a')]
  expect(links.map(link => link.href)).toEqual(['https://example.com/path', 'http://example.org/'])
  for (const link of links) {
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
    expect(link.textContent).toBe(t('workshop-frontend.Inbox.open_message_link', { url: link.href }))
  }
  expect(container.textContent).toContain(t('workshop-frontend.Inbox.message_links_hint'))
  const frame = container.querySelector('iframe')!
  expect(frame.getAttribute('sandbox')).toBe('')
  expect(frame.srcdoc).toContain("script-src 'none'")
  const content = new DOMParser().parseFromString(frame.srcdoc, 'text/html')
  expect(content.querySelector('a[href]')).toBeNull()
})

it('honors plain MIME metadata even when text contains real HTML syntax in display, quotes and resumed drafts', async () => {
  const body = 'Please contact <support@example.com> today. Literal <p>example</p> & text.'
  const original: Email = { id: 'plain', sender: 'writer@example.com', recipient: 'me@example.com', subject: 'Plain', body, raw_headers: JSON.stringify([{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }]), date: '', read: false, starred: false }
  const type = emailBodyType(original)
  expect(type).toBe('text/plain')
  expect(new DOMParser().parseFromString(emailDocument(body, type), 'text/html').body.textContent).toBe(body)
  const forward = initialComposeFields('forward', 'me@example.com', original)
  expect(plainText(forward.body)).toContain(body)
  const draft = initialComposeFields('draft', 'me@example.com', original)
  expect(plainText(draft.body, 'text/html')).toBe(body)
  await act(async () => root.render(<EmailBody body={body} type={type} />))
  const toggle = [...container.querySelectorAll('button')].find(button => button.textContent === t('workshop-frontend.Inbox.show_text'))!
  await act(async () => toggle.click())
  expect(container.querySelector('pre')?.textContent).toBe(body)
})
