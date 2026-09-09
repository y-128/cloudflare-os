import ja from './locales/ja.ts'
import en from './locales/en.ts'

/** A supported interface language. */
export type Locale = 'ja' | 'en'

/** Values substituted into named message parameters. */
export type TranslationParams = Record<string, string | number>

const dictionaries: Record<Locale, Record<string, string>> = { ja, en }

/** Resolves a message with an explicit fallback and interpolates its named parameters. */
export function translateWithFallback(
  locale: Locale,
  key: string,
  fallback: string,
  params?: TranslationParams,
): string {
  const dictionary = dictionaries[locale]
  const message = Object.hasOwn(dictionary, key) ? dictionary[key] : fallback
  // Leave unknown parameters intact, including names inherited from Object.prototype.
  return message.replace(/\{(\w+)\}/g, (match: string, name: string) =>
    params && Object.hasOwn(params, name) ? String(params[name]) : match,
  )
}

/** Translates using an explicit locale without React, browser state, or request-global mutation. */
export function translate(locale: Locale, key: string, params?: TranslationParams): string {
  return translateWithFallback(locale, key, key, params)
}
