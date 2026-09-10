import { useState } from 'react'
import { Button, Checkbox, Input, Select } from '@cloudflare/kumo'
import { useTranslation } from '@gadgets/i18n'
import { jsonRequest, mailboxPath } from './api'
import { decodeMailFilter, FILTER_ACTIONS, FILTER_FIELDS, FILTER_OPS, type MailFilterRow, type Predicate, type FilterAction } from './mailFilterRules'
import { useMailSettingsMutation } from './useMailSettingsMutation'

/** Edits flat AND rules, preserving all unsupported match/action structures on metadata saves. */
export const MailFilterEditor = ({ mailboxId, initial, onSaved }: { mailboxId: string; initial: MailFilterRow; onSaved: () => void }) => {
  const { t } = useTranslation()
  const [decoded] = useState(() => decodeMailFilter(initial))
  const [name, setName] = useState(initial.name)
  const [priority, setPriority] = useState(initial.priority)
  const [enabled, setEnabled] = useState(!!initial.enabled)
  const [conditions, setConditions] = useState(decoded.mode === 'editable' ? decoded.match.all_of : [])
  const [actions, setActions] = useState(decoded.mode === 'editable' ? decoded.actions : [])
  const mutation = useMailSettingsMutation()
  const condition = (index: number, patch: Partial<Predicate>) => setConditions(items => items.map((item, i) => i === index ? { ...item, ...patch } : item))
  const action = (index: number, next: FilterAction) => setActions(items => items.map((item, i) => i === index ? next : item))
  const save = () => {
    if (decoded.mode === 'invalid' || (decoded.mode === 'editable' && (!conditions.length || !actions.length))) return
    void mutation.run('saveMailFilter', mailboxPath(mailboxId, '/filter-rules'), jsonRequest('PUT', {
      ...(initial.id ? { id: initial.id } : {}), name, priority, enabled,
      match: decoded.mode === 'editable' ? { all_of: conditions } : decoded.match,
      actions: decoded.mode === 'editable' ? actions : decoded.actions,
    }), onSaved)
  }
  return <form className="space-y-4 border-t border-kumo-line pt-4" onSubmit={event => { event.preventDefault(); save() }}>
    <fieldset disabled={mutation.busy || decoded.mode === 'invalid'} className="space-y-3">
      <Input label={t('workshop-frontend.Inbox.filter_name')} value={name ?? ''} onChange={event => setName(event.target.value)} />
      <Input label={t('workshop-frontend.Inbox.filter_priority')} description={t('workshop-frontend.Inbox.filter_priority_hint')} type="number" step={1} required value={priority} onChange={event => setPriority(Number(event.target.value))} />
      <Checkbox label={t('workshop-frontend.Inbox.filter_enabled')} checked={enabled} onCheckedChange={setEnabled} />
      {decoded.mode === 'editable' ? <>
        <p>{t('workshop-frontend.Inbox.filter_all_of')}</p>
        <p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.filter_values_hint')}</p>
        {conditions.map((item, index) => <fieldset key={index} className="space-y-2 rounded-lg border border-kumo-line p-3">
          <legend>{t('workshop-frontend.Inbox.filter_condition', { number: index + 1 })}</legend>
          <Select label={t('workshop-frontend.Inbox.filter_field')} value={item.field.startsWith('header:') ? 'header' : item.field} onValueChange={value => {
            if (value === 'header') condition(index, { field: 'header:' })
            else { const field = FILTER_FIELDS.find(candidate => candidate === value); if (field) condition(index, { field }) }
          }}>{[...FILTER_FIELDS, 'header'].map(value => <Select.Option key={value} value={value}>{t(`workshop-frontend.Inbox.filter_field_${value}`)}</Select.Option>)}</Select>
          {item.field.startsWith('header:') && <Input label={t('workshop-frontend.Inbox.filter_header')} required pattern="[!#$%&'*+.^_`|~0-9A-Za-z-]+" value={item.field.slice(7)} onChange={event => condition(index, { field: `header:${event.target.value}` })} />}
          <Select label={t('workshop-frontend.Inbox.filter_operator')} value={item.op} onValueChange={value => { const op = FILTER_OPS.find(candidate => candidate === value); if (op) condition(index, { op }) }}>{FILTER_OPS.map(value => <Select.Option key={value} value={value}>{t(`workshop-frontend.Inbox.filter_op_${value}`)}</Select.Option>)}</Select>
          <Input label={t('workshop-frontend.Inbox.filter_value')} value={item.value} onChange={event => condition(index, { value: event.target.value })} />
          <Button type="button" variant="ghost" onClick={() => setConditions(items => items.filter((_, i) => i !== index))}>{t('workshop-frontend.Inbox.filter_remove_condition')}</Button>
        </fieldset>)}
        <Button type="button" variant="secondary" onClick={() => setConditions(items => [...items, { field: 'subject', op: 'contains', value: '' }])}>{t('workshop-frontend.Inbox.filter_add_condition')}</Button>
        {actions.map((item, index) => <fieldset key={index} className="space-y-2 rounded-lg border border-kumo-line p-3">
          <legend>{t('workshop-frontend.Inbox.filter_action_number', { number: index + 1 })}</legend>
          <Select label={t('workshop-frontend.Inbox.rule_action')} value={item.type} onValueChange={value => {
            if (value === 'move') action(index, { type: value, folder_id: '' })
            else if (value === 'label') action(index, { type: value, value: '' })
            else if (value === 'forward_to') action(index, { type: value, address: '' })
            else if (value === 'mark_read' || value === 'star') action(index, { type: value })
          }}>{FILTER_ACTIONS.map(value => <Select.Option key={value} value={value}>{t(`workshop-frontend.Inbox.filter_action_${value}`)}</Select.Option>)}</Select>
          {item.type === 'move' && <Input label={t('workshop-frontend.Inbox.folder_name')} required value={item.folder_id} onChange={event => action(index, { ...item, folder_id: event.target.value })} />}
          {item.type === 'label' && <Input label={t('workshop-frontend.Inbox.alias_label')} required value={item.value} onChange={event => action(index, { ...item, value: event.target.value })} />}
          {item.type === 'forward_to' && <><Input label={t('workshop-frontend.Inbox.filter_forward_address')} type="email" required value={item.address} onChange={event => action(index, { ...item, address: event.target.value })} /><p className="text-sm text-kumo-subtle">{t('workshop-frontend.Inbox.filter_forward_hint')}</p></>}
          <Button type="button" variant="ghost" onClick={() => setActions(items => items.filter((_, i) => i !== index))}>{t('workshop-frontend.Inbox.filter_remove_action')}</Button>
        </fieldset>)}
        <Button type="button" variant="secondary" onClick={() => setActions(items => [...items, { type: 'mark_read' }])}>{t('workshop-frontend.Inbox.filter_add_action')}</Button>
      </> : <><p role="status">{t(`workshop-frontend.Inbox.${decoded.mode === 'invalid' ? 'filter_invalid' : 'filter_preserved'}`)}</p><pre className="overflow-x-auto text-sm">{initial.match_json}{'\n'}{initial.actions_json}</pre></>}
    </fieldset>
    {mutation.error && <p role="alert">{mutation.error}</p>}
    {mutation.saved && <p role="status">{t('workshop-frontend.Inbox.saved')}</p>}
    <Button type="submit" disabled={mutation.busy || decoded.mode === 'invalid' || (decoded.mode === 'editable' && (!conditions.length || !actions.length))}>{t('workshop-frontend.Inbox.save')}</Button>
  </form>
}
