import { describeError } from '../../../../inbox/workers/lib/describe-error'

/** The GET endpoint returns SQL rows, while PUT accepts decoded match/actions. */
export interface MailFilterRow {
  id: string; name: string | null; priority: number; enabled: number;
  match_json: string; actions_json: string;
}
/** Keep the browser contract local: importing the Worker engine pulls in node:url. */
export const FILTER_FIELDS = ['from', 'from_full', 'from_local', 'from_domain', 'from_display_name', 'to', 'cc', 'subject', 'body', 'subaddress', 'has_attachment'] as const
export const FILTER_OPS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'matches', 'regex', 'in_list'] as const
export const FILTER_ACTIONS = ['move', 'mark_read', 'star', 'label', 'forward_to'] as const
export interface Predicate { field: typeof FILTER_FIELDS[number] | `header:${string}`; op: typeof FILTER_OPS[number]; value: string }
export type FilterAction = { type: 'move'; folder_id: string } | { type: 'mark_read' } | { type: 'star' } | { type: 'label'; value: string } | { type: 'forward_to'; address: string; keep_original?: boolean }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const knownKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const isPredicate = (value: unknown): value is Predicate => isRecord(value) && knownKeys(value, ['field', 'op', 'value']) && typeof value.field === 'string' && (FILTER_FIELDS.some(field => field === value.field) || /^header:.+$/.test(value.field)) && FILTER_OPS.some(op => op === value.op) && typeof value.value === 'string'
const isAction = (value: unknown): value is FilterAction => {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'mark_read': case 'star': return knownKeys(value, ['type'])
    case 'move': return knownKeys(value, ['type', 'folder_id']) && typeof value.folder_id === 'string'
    case 'label': return knownKeys(value, ['type', 'value']) && typeof value.value === 'string'
    case 'forward_to': return knownKeys(value, ['type', 'address', 'keep_original']) && typeof value.address === 'string' && (value.keep_original === undefined || typeof value.keep_original === 'boolean')
    default: return false
  }
}
export type DecodedMailFilter =
  | { mode: 'editable'; match: { all_of: Predicate[] }; actions: FilterAction[] }
  | { mode: 'preserved'; match: Record<string, unknown>; actions: Record<string, unknown>[] }
  | { mode: 'invalid' }

/** Unknown/nested structures remain untouched; malformed JSON can never be saved over. */
export const decodeMailFilter = (row: MailFilterRow): DecodedMailFilter => {
  try {
    const match: unknown = JSON.parse(row.match_json)
    const actions: unknown = JSON.parse(row.actions_json)
    if (!isRecord(match) || !Array.isArray(actions) || !actions.every(isRecord)) return { mode: 'invalid' }
    if (knownKeys(match, ['all_of']) && Array.isArray(match.all_of) && match.all_of.every(isPredicate) && actions.every(isAction)) {
      return { mode: 'editable', match: { all_of: match.all_of }, actions }
    }
    return { mode: 'preserved', match, actions }
  } catch (err) {
    // JSON parser messages can contain mail conditions. Log a bounded error without the input.
    console.error('[decodeMailFilter] failed', { err: describeError(new Error(err instanceof SyntaxError ? 'Invalid filter JSON' : 'Unable to decode filter')) })
    return { mode: 'invalid' }
  }
}

export const newMailFilter = (): MailFilterRow => ({ id: '', name: '', priority: 100, enabled: 1, match_json: JSON.stringify({ all_of: [{ field: 'subject', op: 'contains', value: '' }] }), actions_json: JSON.stringify([{ type: 'mark_read' }]) })
