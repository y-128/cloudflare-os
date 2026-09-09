import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocale, initI18n, setLocale, t, translate } from './index.ts'
import { translateWithFallback } from './core.ts'
import ja from './locales/ja.ts'
import en from './locales/en.ts'

const HOME_KEY = 'workshop-frontend.Sidebar.home'

describe('translation runtime', () => {
  beforeEach(() => { setLocale('ja') })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it('defaults to Japanese and translates explicit locales without changing global state', () => {
    expect(getLocale()).toBe('ja')
    expect(t(HOME_KEY)).toBe('ホーム')
    expect(translate('en', HOME_KEY)).toBe('Home')
    expect(translate('ja', HOME_KEY)).toBe('ホーム')
    expect(getLocale()).toBe('ja')
    expect(translate('en', 'constructor')).toBe('constructor')
  })

  it('distinguishes missing keys, explicit empty fallbacks, and development versus production', () => {
    vi.stubEnv('DEV', true)
    expect(t('absent')).toBe('[missing: absent]')
    expect(t('toString')).toBe('[missing: toString]')
    expect(t('absent', '')).toBe('')
    expect(t(HOME_KEY, 'unused')).toBe('ホーム')
    vi.stubEnv('DEV', false)
    expect(t('absent')).toBe('absent')
  })

  it('interpolates own string and number parameters while preserving unknown names', () => {
    expect(t('absent', '{name}: {count}, {unknown}, {constructor}', { name: '文書', count: 0 }))
      .toBe('文書: 0, {unknown}, {constructor}')
    expect(translateWithFallback('en', 'absent', '{name}', { name: '{count}' })).toBe('{count}')
    vi.stubEnv('DEV', false)
    expect(t('{name}', { name: '日本語' })).toBe('日本語')
    expect(translate('ja', '{count}', { count: 0 })).toBe('0')
  })

  it('gives saved preferences priority, validates them, and synchronizes document language on init', () => {
    const getItem = vi.fn().mockReturnValue('ja')
    const setItem = vi.fn()
    const documentElement = { lang: 'en' }
    vi.stubGlobal('window', { localStorage: { getItem, setItem }, navigator: { language: 'en-US' } })
    vi.stubGlobal('document', { documentElement })
    initI18n()
    expect(getLocale()).toBe('ja')
    expect(documentElement.lang).toBe('ja')
    getItem.mockReturnValue('constructor')
    initI18n()
    expect(getLocale()).toBe('en')
    setLocale('ja')
    expect(setItem).toHaveBeenCalledWith('locale', 'ja')
    expect(documentElement.lang).toBe('ja')
  })

  it('falls back to Japanese for unsupported browser languages', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => null }, navigator: { language: 'fr-FR' } })
    initI18n()
    expect(getLocale()).toBe('ja')
  })

  it('logs storage failures and keeps initialization and switching usable', () => {
    const failure = new Error('storage denied')
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('window', { get localStorage() { throw failure }, navigator: { language: 'en' } })
    vi.stubGlobal('document', { documentElement: { lang: '' } })
    initI18n()
    expect(getLocale()).toBe('ja')
    setLocale('en')
    expect(getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(errorLog).toHaveBeenCalledTimes(2)
    expect(errorLog).toHaveBeenCalledWith('[saveLocale] 失敗', expect.objectContaining({ err: failure }))
  })

  it('can initialize and switch without a browser', () => {
    initI18n()
    setLocale('en')
    expect(t(HOME_KEY)).toBe('Home')
  })

  it('keeps both generated dictionaries in exact key parity with string values', () => {
    expect(Object.keys(ja)).toEqual(Object.keys(en))
    expect(Object.values(ja).every(value => typeof value === 'string')).toBe(true)
    expect(Object.values(en).every(value => typeof value === 'string')).toBe(true)
  })
})
