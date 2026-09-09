// Copyright (c) 2026 y-128
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react'
import { translateWithFallback, type Locale, type TranslationParams } from './core.ts'
import { receiveFrameLocale } from './frame.ts'

export { translate, type Locale, type TranslationParams } from './core.ts'

const DEFAULT_LOCALE: Locale = 'ja'
const STORAGE_KEY = 'locale'
let current: Locale = DEFAULT_LOCALE
const listeners = new Set<() => void>()

/** Checks stored or externally supplied language values without trusting a cast. */
function isLocale(value: unknown): value is Locale {
  return value === 'ja' || value === 'en'
}

/** Reads the saved browser preference and reports storage access failures to its caller. */
function readSavedLocale(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch (err) {
    console.error('[readSavedLocale] 失敗', { context: STORAGE_KEY, err })
    throw err
  }
}

/** Saves the browser preference and reports storage access failures to its caller. */
function saveLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale)
  } catch (err) {
    console.error('[saveLocale] 失敗', { context: { key: STORAGE_KEY, locale }, err })
    throw err
  }
}

/** Applies the locale to document metadata and notifies mounted consumers. */
function applyLocale(locale: Locale): void {
  current = locale
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  for (const listener of listeners) listener()
}

/** Initializes language from saved preference, then browser language, with Japanese as default. */
export function initI18n(): void {
  if (typeof window === 'undefined') return
  let locale = DEFAULT_LOCALE
  try {
    const saved = readSavedLocale()
    locale = isLocale(saved) ? saved : window.navigator.language.toLowerCase().startsWith('en') ? 'en' : 'ja'
  } catch {
    // Storage is optional: a blocked browser store retains the original Japanese default.
  }
  applyLocale(locale)
}

/** Returns the current browser interface language. */
export function getLocale(): Locale {
  return current
}

/** Initializes a trusted opaque-origin app's language and optional title without using localStorage. */
export function initFrameI18n(titleKey?: string): () => void {
  const apply = (locale: Locale) => {
    applyLocale(locale)
    if (titleKey) document.title = t(titleKey)
  }
  apply(current)
  return receiveFrameLocale(apply)
}

/** Changes the interface language immediately and persists it when browser storage is available. */
export function setLocale(locale: Locale): void {
  if (!isLocale(locale)) return
  if (typeof window !== 'undefined') {
    try {
      saveLocale(locale)
    } catch {
      // A storage failure must not prevent an in-memory language change.
    }
  }
  applyLocale(locale)
}

/** Translates in the current language with optional fallback text and named parameters. */
export function t(
  key: string,
  fallbackOrParams?: string | TranslationParams,
  params?: TranslationParams,
): string {
  const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : undefined
  return translateWithFallback(
    current,
    key,
    fallback ?? (import.meta.env?.DEV ? `[missing: ${key}]` : key),
    typeof fallbackOrParams === 'string' ? params : fallbackOrParams ?? params,
  )
}

/** Subscribes React to language changes and releases the subscription when it unmounts. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Supplies a stable Japanese snapshot for non-browser rendering. */
function getServerLocale(): Locale {
  return DEFAULT_LOCALE
}

/** Returns translation helpers and re-renders the component when the language changes. */
export function useTranslation() {
  const locale = useSyncExternalStore(subscribe, getLocale, getServerLocale)
  return { t, locale, setLocale }
}

/** Interleaves named React values while allowing a translated sentence to reorder links and emphasis. */
export function renderTranslation(message: string, values: Record<string, ReactNode>): ReactNode {
  return message.split(/(\{\w+\})/g).map((part, index) => {
    const name = part.slice(1, -1)
    return createElement(Fragment, { key: index },
      /^\{\w+\}$/.test(part) && Object.hasOwn(values, name) ? values[name] : part)
  })
}
