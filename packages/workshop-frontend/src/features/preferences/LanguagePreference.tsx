import { Select } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'

/** Shows a language's native name rather than its internal locale code. */
const renderLanguageName = (value: string | null) => value === 'ja' ? '日本語' : 'English'

/** Changes the browser's display language from the existing profile settings page. */
export const LanguagePreference = () => {
  const { t, locale, setLocale } = useTranslation()

  /** Applies only a supported locale from the select control. */
  const handleLocaleChange = (value: string | null) => {
    if (value === 'ja' || value === 'en') setLocale(value)
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="rounded-xl border border-kumo-line bg-kumo-base px-5 py-4">
        <Select
          label={t('workshop-frontend.LanguagePreference.language')}
          value={locale}
          renderValue={renderLanguageName}
          onValueChange={handleLocaleChange}
        >
          <Select.Option value="ja"><span lang="ja">日本語</span></Select.Option>
          <Select.Option value="en"><span lang="en">English</span></Select.Option>
        </Select>
        <p className="mt-1.5 text-[12px] text-kumo-subtle">
          {t('workshop-frontend.LanguagePreference.description')}
        </p>
      </div>
    </section>
  )
}
