import { expect, it } from 'vitest'
import ja from './locales/ja'
import en from './locales/en'
import { supplementalTranslations } from '../../../scripts/i18n/supplemental'

it.each(['template_hint', 'template_shortcut', 'template_shortcut_invalid'])('uses Japanese shortcut wording and keeps supplemental translations synchronized: %s', name => {
  const key = `workshop-frontend.Inbox.${name}` as keyof typeof ja
  expect(ja[key]).toContain('ショートカット')
  expect(ja[key]).not.toContain('shortcut')
  expect(supplementalTranslations[key]).toEqual({ ja: ja[key], en: en[key] })
})
