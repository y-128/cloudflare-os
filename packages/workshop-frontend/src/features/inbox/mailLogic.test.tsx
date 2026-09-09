// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@gadgets/i18n'
import { composeEndpoint, groupThreads, initialComposeFields, parseInboxSearch, parseSearchQuery, validateCompose } from './mailLogic'
import { emailDocument } from './EmailBody'
import type { Email } from './types'

const original: Email = { id: 'internal/id', message_id: 'mime@example.com', thread_id: 'conversation', subject: 'Status', sender: 'Writer <writer@example.com>', recipient: 'me@example.com, colleague@example.com', cc: 'COLLEAGUE@example.com, other@example.com, me@example.com', bcc: 'hidden@example.com', date: '2026-09-09T01:00:00Z', read: false, starred: false, body: '<p>Original</p><script>attack()</script>' }
beforeEach(() => setLocale('en'))

describe('mail navigation and grouping', () => {
  it('preserves exact notifier IDs and rejects coerced non-string values', () => {
    expect(parseInboxSearch({ mailboxId: 'a+tag@example.com', emailId: 'a/b' })).toEqual({ mailboxId: 'a+tag@example.com', emailId: 'a/b' })
    expect(parseInboxSearch({ mailboxId: ['other'], emailId: 123 })).toEqual({ mailboxId: undefined, emailId: undefined })
  })
  it('groups thread identities, sums unread counts, and keeps unrelated equal subjects separate', () => {
    const rows = groupThreads([original, { ...original, id: 'reply', date: '2026-09-09T02:00:00Z', read: true }, { ...original, id: 'unrelated', thread_id: null }])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: 'reply', thread_count: 2, thread_unread_count: 1 })
    expect(rows[1].id).toBe('unrelated')
  })
  it('preserves worker aggregates instead of replacing them with a count of one', () => {
    expect(groupThreads([{ ...original, thread_count: 8, thread_unread_count: 3 }])[0]).toMatchObject({ thread_count: 8, thread_unread_count: 3 })
  })
})

describe('search contract', () => {
  it('parses quoted operators and all REST filters including false booleans', () => {
    expect(parseSearchQuery('budget from:"John Doe" to:me@example.com subject:"Re: Hello" in:spam is:unread is:unstarred has:attachment after:2026-01-01 before:2026-02-01')).toEqual({ query: 'budget', from: 'John Doe', to: 'me@example.com', subject: 'Re: Hello', folder: 'spam', is_read: 'false', is_starred: 'false', has_attachment: 'true', date_start: '2026-01-01T00:00:00.000Z', date_end: '2026-02-01T00:00:00.000Z' })
  })
  it('keeps invalid and unsupported operators visible to full-text search', () => {
    expect(parseSearchQuery('is:unknown before:invalid label:work')).toEqual({ query: 'is:unknown before:invalid label:work' })
  })
})

describe('compose headers and validation', () => {
  it('excludes self, deduplicates To/Cc case-insensitively, and never copies Bcc on reply-all', () => {
    const fields = initialComposeFields('reply-all', 'ME@example.com', original)
    expect(fields).toMatchObject({ to: 'writer@example.com, colleague@example.com', cc: 'other@example.com', bcc: '', subject: 'Re: Status' })
    expect(fields.body).not.toContain('<script>')
    expect(composeEndpoint('reply-all', original)).toBe('/emails/internal%2Fid/reply')
  })
  it('constructs forward headers and quoted metadata without setting reply threading', () => {
    const fields = initialComposeFields('forward', 'me@example.com', original)
    expect(fields).toMatchObject({ to: '', cc: '', bcc: '', subject: 'Fwd: Status' })
    expect(fields.body).toContain('Forwarded message')
    expect(fields.body).toContain('Writer &lt;writer@example.com&gt;')
    expect(composeEndpoint('forward', original)).toBe('/emails/internal%2Fid/forward')
    expect(initialComposeFields('reply', 'me@example.com', { ...original, subject: 're: Status' }).subject).toBe('re: Status')
  })
  it('resumes reply drafts using their original ID and keeps ordinary drafts as new mail', () => {
    expect(composeEndpoint('draft', { ...original, in_reply_to: 'original/id' })).toBe('/emails/original%2Fid/reply')
    expect(composeEndpoint('draft', { ...original, in_reply_to: null })).toBe('/emails')
  })
  it('rejects missing recipients, malformed Cc and empty HTML, accepting valid rich mail', () => {
    const fields = initialComposeFields('new', 'me@example.com')
    expect(validateCompose(fields)).toContain('recipient')
    expect(validateCompose({ ...fields, to: 'valid@example.com', cc: 'bad', body: '<p>Hello</p>' })).toContain('recipient')
    expect(validateCompose({ ...fields, to: 'valid@example.com', body: '<p><br></p>' })).toContain('body')
    expect(validateCompose({ ...fields, to: 'valid@example.com', body: '<p>Hello <strong>world</strong></p>' })).toBeNull()
  })
})

it('sanitizes active content and forbids external tracking and script execution in the document CSP', () => {
  const document = emailDocument('<script>alert(1)</script><img src="https://track.example/pixel" onerror="attack()"><form action="https://evil.example">bad</form>')
  expect(document).not.toContain('<script>')
  expect(document).not.toContain('onerror')
  expect(document).not.toContain('<form')
  expect(document).toContain("script-src 'none'")
  expect(document).toContain("img-src data:")
})
