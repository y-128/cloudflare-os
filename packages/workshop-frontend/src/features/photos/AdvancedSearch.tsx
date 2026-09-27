import { useState } from 'react'
import { Button, Checkbox, Input } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import type { NumericField, SearchQuery } from '../../../../photos/shared/search-query'
import { OptionSelect } from './OptionSelect'
import { formatSearch, parseSearch } from './searchSyntax'

type Bound = 'gte' | 'lte'
type Tristate = 'any' | 'yes' | 'no'

/** The number a query bounds `field` by from one side, or '' when it does not. */
export function numericBound(query: SearchQuery, field: NumericField, op: Bound): string {
  const found = query.numeric?.find(condition => condition.field === field && condition.op === op)
  return found ? String(found.value) : ''
}

/** Replaces the bound on one side of `field`; an empty or non-numeric value removes it. */
export function withNumericBound(query: SearchQuery, field: NumericField, op: Bound, text: string): SearchQuery {
  const rest = (query.numeric ?? []).filter(condition => !(condition.field === field && condition.op === op))
  const value = Number(text)
  const numeric = text.trim() !== '' && Number.isFinite(value) ? [...rest, { field, op, value }] : rest
  return { ...query, numeric: numeric.length ? numeric : undefined }
}

const tristate = (value: boolean | undefined): Tristate => value === undefined ? 'any' : value ? 'yes' : 'no'
const fromTristate = (value: Tristate | null): boolean | undefined => value === 'yes' ? true : value === 'no' ? false : undefined

const toDateInput = (time: number | undefined) => {
  if (time === undefined) return ''
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const RANGES: { field: NumericField; label: string }[] = [
  { field: 'iso', label: 'ISO' },
  { field: 'fNumber', label: 'F' },
  { field: 'focalLength35mm', label: 'mm (35mm)' },
]

/**
 * A form over the search bar's syntax: it parses the current text, edits the structured query,
 * and writes it back as text, so the bar remains the one place a search lives.
 */
export function AdvancedSearch({ text, onSearch, onClose }: {
  text: string
  onSearch: (text: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState<SearchQuery>(() => parseSearch(text))
  const update = (change: Partial<SearchQuery>) => setQuery(current => ({ ...current, ...change }))
  const tristateOptions = (['any', 'yes', 'no'] as const).map(value => ({ value, label: t(`workshop-frontend.Photos.tristate_${value}`) }))
  const date = (value: string, endOfDay: boolean) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return undefined
    const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
    return endOfDay ? start + 24 * 60 * 60 * 1000 - 1 : start
  }

  return (
    <form aria-label={t('workshop-frontend.Photos.advanced_search')} className="grid gap-3 border-b border-kumo-line p-3 text-sm sm:grid-cols-2 lg:grid-cols-4 [&_input]:min-w-0"
      onSubmit={event => { event.preventDefault(); onSearch(formatSearch(query)) }}>
      <label className="grid gap-1 text-xs text-kumo-subtle sm:col-span-2">{t('workshop-frontend.Photos.search_text')}
        <Input aria-label={t('workshop-frontend.Photos.search_text')} value={query.text ?? ''} onChange={event => update({ text: event.target.value || undefined })} />
      </label>
      <label className="grid gap-1 text-xs text-kumo-subtle">{t('workshop-frontend.Photos.camera')}
        <Input aria-label={t('workshop-frontend.Photos.camera')} value={query.cameraModels?.[0] ?? ''}
          onChange={event => update({ cameraModels: event.target.value ? [event.target.value] : undefined })} />
      </label>
      <label className="grid gap-1 text-xs text-kumo-subtle">{t('workshop-frontend.Photos.lens')}
        <Input aria-label={t('workshop-frontend.Photos.lens')} value={query.lensModels?.[0] ?? ''}
          onChange={event => update({ lensModels: event.target.value ? [event.target.value] : undefined })} />
      </label>
      <label className="grid gap-1 text-xs text-kumo-subtle">{t('workshop-frontend.Photos.taken_from')}
        <Input type="date" aria-label={t('workshop-frontend.Photos.taken_from')} value={toDateInput(query.takenFrom)}
          onChange={event => update({ takenFrom: date(event.target.value, false) })} />
      </label>
      <label className="grid gap-1 text-xs text-kumo-subtle">{t('workshop-frontend.Photos.taken_to')}
        <Input type="date" aria-label={t('workshop-frontend.Photos.taken_to')} value={toDateInput(query.takenTo)}
          onChange={event => update({ takenTo: date(event.target.value, true) })} />
      </label>
      {RANGES.map(({ field, label }) => (
        <div key={field} className="grid gap-1 text-xs text-kumo-subtle">
          {label}
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
            {(['gte', 'lte'] as const).map((op, index) => (
              <span key={op} className="contents">
                {index === 1 && <span aria-hidden>–</span>}
                <Input inputMode="decimal" className="w-full min-w-0" aria-label={t(`workshop-frontend.Photos.range_${op}`, { field: label })}
                  value={numericBound(query, field, op)} onChange={event => setQuery(current => withNumericBound(current, field, op, event.target.value))} />
              </span>
            ))}
          </div>
        </div>
      ))}
      <OptionSelect<Tristate> label={t('workshop-frontend.Photos.has_raw')} value={tristate(query.hasRaw)} options={tristateOptions}
        onChange={value => update({ hasRaw: fromTristate(value) })} />
      <OptionSelect<Tristate> label={t('workshop-frontend.Photos.duplicates')} value={tristate(query.duplicates)} options={tristateOptions}
        onChange={value => update({ duplicates: fromTristate(value) })} />
      <div className="self-end">
        <Checkbox label={t('workshop-frontend.Photos.favorites_only')} checked={query.favorite === true}
          onCheckedChange={checked => update({ favorite: checked === true ? true : undefined })} />
      </div>
      <div className="flex items-end justify-end gap-2 sm:col-span-2 lg:col-span-4">
        <Button type="button" variant="ghost" size="sm" onClick={() => setQuery({})}>{t('workshop-frontend.Photos.clear')}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('workshop-frontend.Photos.close')}</Button>
        <Button type="submit" size="sm">{t('workshop-frontend.Photos.search_run')}</Button>
      </div>
    </form>
  )
}
