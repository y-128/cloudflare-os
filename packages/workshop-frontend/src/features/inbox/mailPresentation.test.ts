// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { setLocale } from '@gadgets/i18n'
import { formatMailDate, mailDate, mailListPath, mailSenderName } from './mailPresentation'

describe('mail list requests', () => {
  it('filters on the server before pagination and scopes folder shortcuts', () => {
    expect(mailListPath('spam', '', 'unread', 2, 30)).toBe('/search?query=&folder=spam&is_read=false&page=2&limit=30')
    expect(mailListPath('inbox', '', 'attachment', 1, 30)).toContain('has_attachment=true')
    expect(mailListPath('starred', '', 'all', 1, 30)).toContain('is_starred=true')
    expect(mailListPath('inbox', '', 'all', 1, 30)).toContain('/emails?folder=inbox&threaded=true')
  })
  it('retains explicit search operators rather than overriding them with the selected folder', () => {
    const params = new URLSearchParams(mailListPath('inbox', 'in:archive from:contact@例え.test', 'all', 1, 30).split('?')[1])
    expect(params.get('folder')).toBe('archive')
    expect(params.get('from')).toBe('contact@例え.test')
  })
})

it('formats dates without changing API identity or inventing a date for invalid legacy data', () => {
  setLocale('ja')
  expect(mailDate('2026-09-11 01:02:03').toISOString()).toBe('2026-09-11T01:02:03.000Z')
  expect(formatMailDate('invalid', 'ja')).toBe('invalid')
  expect(formatMailDate('2026-09-10T12:00:00', 'ja', new Date('2026-09-11T12:00:00'))).toBe('昨日')
  expect(mailSenderName('"サンプルサポート" <contact@例え.test>')).toBe('サンプルサポート')
  expect(mailSenderName('contact@サンプル.test')).toBe('contact@サンプル.test')
})
