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
 * Parses the search bar: `camera:"ILCE-7M4" lens:35mm iso<=800 f<2.8 shutter<=1/500 raw:yes fav
 * from:2026-09-01 to:2026-09-30` plus free text. Unrecognized `key:value` tokens stay free text,
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
