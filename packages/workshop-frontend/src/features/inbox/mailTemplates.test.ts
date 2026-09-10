// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { expandPlaceholders, expandTemplate, findTemplateShortcut, recipientDisplayName, type MailTemplate } from './mailTemplates'

const template: MailTemplate = { id: 'one', name: 'Greeting', shortcut: '/hello', subject: 'Hello {{recipient_name}}', body: '{{sender_name}}\n{{date}}' }
const variables = { recipient_name: '花子', sender_name: '太郎', date: '2026/9/10' }

it('substitutes only the three allowed variables once and preserves unknown expressions', () => {
  expect(expandPlaceholders('{{ recipient_name }} {{sender_name}} {{date}} {{unknown}} {{constructor}} {{1 + 1}}', variables)).toBe('花子 太郎 2026/9/10 {{unknown}} {{constructor}} {{1 + 1}}')
  expect(expandPlaceholders('{{sender_name}}', { ...variables, sender_name: '{{date}}' })).toBe('{{date}}')
  expect(expandPlaceholders('{{recipient_name}} {{sender_name}}', { ...variables, recipient_name: '', sender_name: '' })).toBe(' ')
})

it('uses the first explicitly entered name, including quoted separators, without guessing missing names', () => {
  expect(recipientDisplayName('"山田, \\"営業\\"" <a@example.com>, Other <b@example.com>')).toBe('山田, "営業"')
  expect(recipientDisplayName('花子 <a@example.com>')).toBe('花子')
  expect(recipientDisplayName('a@example.com, Other <b@example.com>')).toBe('')
  expect(recipientDisplayName('')).toBe('')
})

it('expands plain text and HTML while escaping names and never expanding attributes', () => {
  const hostile = { ...variables, sender_name: '<img src=x onerror=alert(1)> & {{date}}' }
  const result = expandTemplate({ ...template, body: '<p>{{sender_name}}</p><a href="https://example.com/{{date}}">{{date}}</a><script>alert(1)</script>' }, hostile)
  const element = document.createElement('div'); element.innerHTML = result.body
  expect(element.querySelector('img,script')).toBeNull()
  expect(element.querySelector('p')?.textContent).toBe(hostile.sender_name)
  expect(element.querySelector('a')?.getAttribute('href')).toBe('https://example.com/{{date}}')
  expect(result.subject).toBe('Hello 花子')
  expect(expandTemplate(template, variables).body).toBe('<p>太郎<br>2026/9/10</p>')
})

it('matches only unique complete shortcut tokens at the cursor', () => {
  expect(findTemplateShortcut('Before /hello', [template])).toBe(template)
  expect(findTemplateShortcut('/hello', [template])).toBe(template)
  expect(findTemplateShortcut('word/hello', [template])).toBeUndefined()
  expect(findTemplateShortcut('/hello ', [template])).toBeUndefined()
  expect(findTemplateShortcut('/hel', [template])).toBeUndefined()
  expect(findTemplateShortcut('/hello', [template, { ...template, id: 'two' }])).toBeUndefined()
})
