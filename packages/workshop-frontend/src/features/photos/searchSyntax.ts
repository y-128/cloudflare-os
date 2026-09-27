import type { NumericField, NumericOp, SearchQuery } from '../../../../photos/shared/search-query'

/** Search-bar field names and the numeric field each compares. */
const NUMERIC_ALIASES: Record<string, NumericField> = {
  iso: 'iso',
  f: 'fNumber',
  focal: 'focalLength35mm',
  mm: 'focalLengthMm',
  shutter: 'exposureTimeS',
  rating: 'rating',
}

const OPERATORS: [string, NumericOp][] = [['<=', 'lte'], ['>=', 'gte'], ['<', 'lt'], ['>', 'gt'], ['=', 'eq']]

/** Splits on whitespace, keeping `"quoted values"` (and `key:"quoted values"`) whole. */
function tokenize(input: string): string[] {
  return input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
}

const unquote = (value: string) => value.replace(/^"(.*)"$/, '$1').replaceAll('"', '')

/** `1/500` → 0.002; plain numbers pass through. NaN when neither. */
function parseNumber(value: string): number {
  const fraction = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(value)
  return fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(value)
}

/** Local midnight of a `YYYY-MM-DD` date, or NaN. */
function parseDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() : NaN
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Parses the search bar: `camera:"ILCE-7M4" lens:35mm iso<=800 f<2.8 shutter<=1/500 raw:yes dup:yes
 * fav from:2026-09-01 to:2026-09-30` plus free text. Unrecognized `key:value` tokens stay free text,
 * so nothing typed is silently dropped.
 */
export function parseSearch(input: string): SearchQuery {
  const query: SearchQuery = {}
  const text: string[] = []
  const numeric: NonNullable<SearchQuery['numeric']> = []
  for (const token of tokenize(input.trim())) {
    const lower = token.toLowerCase()
    const comparison = /^([a-z]+)(<=|>=|<|>|=)(.+)$/i.exec(token)
    if (comparison && NUMERIC_ALIASES[comparison[1].toLowerCase()]) {
      const value = parseNumber(comparison[3])
      const op = OPERATORS.find(([symbol]) => symbol === comparison[2])?.[1]
      if (op && Number.isFinite(value)) {
        numeric.push({ field: NUMERIC_ALIASES[comparison[1].toLowerCase()], op, value })
        continue
      }
    }
    const pair = /^([a-z]+):(.+)$/i.exec(token)
    const key = pair?.[1].toLowerCase()
    const value = pair ? unquote(pair[2]) : ''
    if (key === 'camera' && value) {
      query.cameraModels = [...query.cameraModels ?? [], value]
    } else if (key === 'lens' && value) {
      query.lensModels = [...query.lensModels ?? [], value]
    } else if (key === 'raw' && ['yes', 'no'].includes(value.toLowerCase())) {
      query.hasRaw = value.toLowerCase() === 'yes'
    } else if (key === 'dup' && ['yes', 'no'].includes(value.toLowerCase())) {
      query.duplicates = value.toLowerCase() === 'yes'
    } else if (key === 'from' && Number.isFinite(parseDate(value))) {
      query.takenFrom = parseDate(value)
    } else if (key === 'to' && Number.isFinite(parseDate(value))) {
      query.takenTo = parseDate(value) + DAY_MS - 1
    } else if (lower === 'fav' || lower === 'favorite') {
      query.favorite = true
    } else {
      text.push(unquote(token))
    }
  }
  if (numeric.length) query.numeric = numeric
  if (text.length) query.text = text.join(' ')
  return query
}

const FIELD_ALIAS: Record<NumericField, string> = {
  iso: 'iso', fNumber: 'f', focalLength35mm: 'focal', focalLengthMm: 'mm', exposureTimeS: 'shutter', rating: 'rating',
}
const OPERATOR_SYMBOL = Object.fromEntries(OPERATORS.map(([symbol, op]) => [op, symbol])) as Record<NumericOp, string>

const quote = (value: string) => /\s/.test(value) ? `"${value}"` : value

function formatDate(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatNumber(field: NumericField, value: number): string {
  return field === 'exposureTimeS' && value > 0 && value < 1 ? `1/${Math.round(1 / value)}` : String(value)
}

/**
 * Writes a query back as search-bar text, the inverse of {@link parseSearch} for everything the
 * bar can express, so the detailed search form and the bar stay one source of truth.
 */
export function formatSearch(query: SearchQuery): string {
  const tokens: string[] = []
  for (const model of query.cameraModels ?? []) tokens.push(`camera:${quote(model)}`)
  for (const lens of query.lensModels ?? []) tokens.push(`lens:${quote(lens)}`)
  for (const { field, op, value } of query.numeric ?? []) tokens.push(`${FIELD_ALIAS[field]}${OPERATOR_SYMBOL[op]}${formatNumber(field, value)}`)
  if (query.hasRaw !== undefined) tokens.push(`raw:${query.hasRaw ? 'yes' : 'no'}`)
  if (query.duplicates !== undefined) tokens.push(`dup:${query.duplicates ? 'yes' : 'no'}`)
  if (query.favorite) tokens.push('fav')
  if (query.takenFrom !== undefined) tokens.push(`from:${formatDate(query.takenFrom)}`)
  if (query.takenTo !== undefined) tokens.push(`to:${formatDate(query.takenTo)}`)
  if (query.text) tokens.push(query.text)
  return tokens.join(' ')
}
