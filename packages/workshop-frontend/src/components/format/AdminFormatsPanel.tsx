import { useTranslation, renderTranslation } from "@gadgets/i18n";
// Admin panel for the deployment's standard output formats.
//
// A format is an ordinary blueprint the deployment has *promoted*: offered as "New Slides" and
// listed first for the agent. Promoting changes four surfaces the admin can't see from here, so
// the panel previews the buttons users will get and the literal line the model will read.
//
// Presentation is never authored from scratch: a promoted blueprint arrives with its own noun,
// plural and icon, and clearing an override falls back to it.

import { useEffect, useMemo, useState } from 'react'
import { Button, DropdownMenu, Input, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowDown, ArrowUp, CaretDown, CaretRight, Plus, Sparkle, Trash, Warning } from '@phosphor-icons/react'
import type {
  AdminApi,
  AdminFormat,
  BlueprintOutput,
  OutputIcon,
} from '@gadgets/workshop-shared/api'
import { OUTPUT_ICONS } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { useAuthenticatedApi } from '../../AuthContext'
import { MENU_CONTENT } from '../menuStyles'
import { FORMAT_ICONS, GENERIC_OUTPUT } from './formats'
import { FormatGlyph, FormatPreview } from './FormatVisuals'
import { isImeComposing } from '../../keyboardEvent'

// A blueprint the admin could promote. `declared` is what it says it produces, when we know --
// known for the deployment's featured blueprints, unknown for the admin's own published ones.
type Promotable = { id: string; title: string; declared?: BlueprintOutput }

export default function AdminFormatsPanel({
  admin,
  formats,
  onChanged,
}: {
  admin: RpcStub<AdminApi>
  formats: AdminFormat[]
  /**
   * Re-fetch after a mutation. Formats are edited rarely, so re-reading beats an optimistic local
   * copy that could disagree about order.
   */
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation();
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Promotable[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all([authenticatedApi.listFeaturedBlueprints(), authenticatedApi.listOwnBlueprints()])
      .then(([featured, own]) => {
        if (cancelled) return
        const byId = new Map<string, Promotable>()
        for (const b of featured) {
          byId.set(b.id, { id: b.id, title: b.metadata.title, declared: b.metadata.output })
        }
        for (const b of own) {
          if (!byId.has(b.id)) byId.set(b.id, { id: b.id, title: b.title })
        }
        setCandidates([...byId.values()])
      })
      .catch((err) => console.error('Failed to list promotable blueprints:', err))
    return () => {
      cancelled = true
    }
  }, [authenticatedApi])

  const promoted = useMemo(() => new Set(formats.map((f) => f.blueprintId)), [formats])
  const available = candidates.filter((c) => !promoted.has(c.id))
  const offered = formats.filter((f) => f.enabled && f.output && !f.missing)

  // Every mutation funnels through here, so the panel can't issue overlapping writes and always
  // re-reads the authoritative order afterwards.
  const mutate = async (op: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await op()
      await onChanged()
    } catch (err) {
      console.error('Format update failed:', err)
      toasts.add({ title: t("workshop-frontend.AdminFormatsPanel.couldn_t_update_standard_formats"), variant: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const move = (index: number, delta: number) => {
    const order = formats.map((f) => f.blueprintId)
    const target = index + delta
    if (target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    return mutate(() => admin.setFormatOrder(order))
  }

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">{t("workshop-frontend.AdminFormatsPanel.standard_formats")}</h2>
      <p className="mb-5 text-sm text-kumo-subtle">
        {t("workshop-frontend.AdminFormatsPanel.a_promoted_blueprint_is_offered_by_name_new_doc_new_slides_wherev")}</p>

      <PreviewStrip formats={offered} />

      {formats.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mb-5 flex flex-col gap-2">
          {formats.map((format, i) => (
            <FormatRow
              key={format.blueprintId}
              format={format}
              busy={busy}
              open={expanded === format.blueprintId}
              onToggle={() =>
                setExpanded((id) => (id === format.blueprintId ? null : format.blueprintId))
              }
              isFirst={i === 0}
              isLast={i === formats.length - 1}
              onMove={(delta) => move(i, delta)}
              onPatch={(patch) => mutate(() => admin.updateFormat(format.blueprintId, patch))}
              onRemove={() => mutate(() => admin.removeFormat(format.blueprintId))}
            />
          ))}
        </div>
      )}

      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <Button variant="secondary" disabled={busy || available.length === 0}>
              <Plus size={14} className="mr-1.5" />{t("workshop-frontend.AdminFormatsPanel.promote_a_blueprint")}</Button>
          }
        />
        <DropdownMenu.Content className={MENU_CONTENT}>
          <p className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
            {t("workshop-frontend.AdminFormatsPanel.offer_as_a_standard_format")}</p>
          {available.map((candidate) => (
            <DropdownMenu.Item
              key={candidate.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-kumo-tint"
              onClick={() => mutate(() => admin.promoteFormat(candidate.id))}
            >
              <FormatGlyph output={candidate.declared} size="lg" className="shrink-0 text-kumo-subtle" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] text-kumo-default">
                  {candidate.title || t("workshop-frontend.AdminFormatsPanel.untitled_blueprint")}
                </span>
                <span className="block truncate text-[11px] text-kumo-inactive">
                  {candidate.declared
                    ? t("workshop-frontend.AdminFormatsPanel.produces", { value1: candidate.declared.plural })
                    : t("workshop-frontend.AdminFormatsPanel.no_declared_format_you_ll_name_it")}
                </span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}

// What users will actually get, drawn with the same components the real surfaces use.
function PreviewStrip({ formats }: { formats: AdminFormat[] }) {
  const { t } = useTranslation();
  return (
    <div className="mb-5 rounded-lg border border-dashed border-kumo-line bg-kumo-tint/40 p-4">
      <p className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        {t("workshop-frontend.AdminFormatsPanel.what_people_will_see")}</p>
      {formats.length === 0 ? (
        <p className="text-[13px] italic text-kumo-inactive">
          {t("workshop-frontend.AdminFormatsPanel.nothing_yet_people_will_only_see_new_workspace")}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {formats.map((format) => (
            <span
              key={format.blueprintId}
              className="flex items-center gap-2 rounded-full border border-kumo-line bg-kumo-base px-3.5 py-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default"
            >
              <FormatGlyph output={format.output} size="md" className="text-kumo-subtle" />{renderTranslation(t("workshop-frontend.AdminFormatsPanel.new_2"), { value1: format.output!.noun })}</span>
          ))}
        </div>
      )}
      <p className="mt-2.5 text-[12px] leading-4 text-kumo-subtle">
        {t("workshop-frontend.AdminFormatsPanel.in_the_composer_s_menu_the_command_palette_and_on_an_empty_outpu")}</p>
    </div>
  )
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="mb-5 rounded-lg border border-kumo-line bg-kumo-base px-4 py-5 text-center">
      <p className="text-sm font-medium text-kumo-default">{t("workshop-frontend.AdminFormatsPanel.no_standard_formats_yet")}</p>
      <p className="mx-auto mt-1 max-w-md text-[13px] leading-[18px] text-kumo-subtle">
        {t("workshop-frontend.AdminFormatsPanel.promote_a_blueprint_to_offer_it_by_name_wherever_people_start_som")}</p>
    </div>
  )
}

function FormatRow({
  format,
  busy,
  open,
  onToggle,
  isFirst,
  isLast,
  onMove,
  onPatch,
  onRemove,
}: {
  format: AdminFormat
  busy: boolean
  open: boolean
  onToggle: () => void
  isFirst: boolean
  isLast: boolean
  onMove: (delta: number) => void
  onPatch: (patch: Parameters<AdminApi['updateFormat']>[1]) => void
  onRemove: () => void
}) {
  const { t } = useTranslation();
  const needsNaming = !format.missing && !format.output

  return (
    <div className="group rounded-lg border border-kumo-line bg-kumo-base">
      <div className="flex items-center gap-3 p-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
        >
          {format.missing ? (
            <span
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-tint text-kumo-danger"
              title={t("workshop-frontend.AdminFormatsPanel.this_blueprint_no_longer_exists")}
            >
              <Warning size={16} />
            </span>
          ) : (
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle">
              <FormatGlyph output={format.output} size="lg" />
            </span>
          )}

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-kumo-default">
                {format.output ? t("workshop-frontend.AdminFormatsPanel.new_2", { value1: format.output.noun }) : format.blueprintTitle || format.blueprintId}
              </span>
              {format.bundled && <Badge>{t("workshop-frontend.AdminFormatsPanel.bundled")}</Badge>}
              {!format.enabled && !format.missing && <Badge>{t("workshop-frontend.AdminFormatsPanel.off")}</Badge>}
              {needsNaming && <Badge tone="warn">{t("workshop-frontend.AdminFormatsPanel.needs_a_name")}</Badge>}
            </span>
            <span className="mt-0.5 block truncate text-xs text-kumo-subtle">
              {format.missing
                ? t("workshop-frontend.AdminFormatsPanel.blueprint_deleted_remove_this_entry")
                : needsNaming
                ? t("workshop-frontend.AdminFormatsPanel.this_blueprint_doesn_t_declare_what_it_produces_give_it_a_name_t")
                : t("workshop-frontend.AdminFormatsPanel.shown_under_on_outputs", { value1: format.blueprintTitle, value2: format.output!.plural })}
            </span>
          </span>

          <span className="shrink-0 text-kumo-inactive">
            {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
          </span>
        </button>

        {/* Reorder stays out of the way until the row is hovered or opened: order matters, but not
            on every glance. */}
        <div
          className={`flex shrink-0 items-center gap-1 transition-opacity ${
            open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
          }`}
        >
          <IconButton label={t("workshop-frontend.AdminFormatsPanel.move_up")} disabled={busy || isFirst} onClick={() => onMove(-1)}>
            <ArrowUp size={13} />
          </IconButton>
          <IconButton label={t("workshop-frontend.AdminFormatsPanel.move_down")} disabled={busy || isLast} onClick={() => onMove(1)}>
            <ArrowDown size={13} />
          </IconButton>
        </div>

        <Switch
          checked={format.enabled}
          disabled={busy || format.missing}
          onCheckedChange={(enabled) => onPatch({ enabled })}
        />
      </div>

      {open && (
        <div className="flex flex-col gap-4 border-t border-kumo-line px-3 py-4">
          {format.missing ? (
            <p className="text-[13px] text-kumo-subtle">
              {t("workshop-frontend.AdminFormatsPanel.the_blueprint_behind_this_format_was_deleted_so_nobody_is_offered")}</p>
          ) : (
            <>
              <Fieldset
                title={t("workshop-frontend.AdminFormatsPanel.how_it_s_presented")}
                detail={
                  format.bundled ? t("workshop-frontend.AdminFormatsPanel.leave_a_field_empty_to_use_the_name_the_blueprint_declares_a_bund") : t("workshop-frontend.AdminFormatsPanel.leave_a_field_empty_to_use_the_name_the_blueprint_declares_applie")
                }
              >
                <div className="flex items-center gap-4">
                  <div className="grid flex-1 gap-2 sm:grid-cols-[auto_1fr_1fr]">
                    {/* Fields read from `output` when the presentation resolves, and otherwise
                        from whatever has been filled in so far. `output` is all-or-nothing -- it
                        is undefined until noun, plural and icon are all present -- so reading only
                        from it made an admin naming an undeclared blueprint watch each value they
                        saved vanish from the form. */}
                    <IconPicker
                      icon={format.output?.icon ?? format.overrides?.icon}
                      declaredIcon={format.declared?.icon}
                      disabled={busy}
                      onPick={(icon) => onPatch({ overrides: { icon } })}
                    />
                    <OverrideField
                      label={t("workshop-frontend.AdminFormatsPanel.name")}
                      value={format.output?.noun ?? format.overrides?.noun ?? ''}
                      declared={format.declared?.noun}
                      disabled={busy}
                      onCommit={(noun) => onPatch({ overrides: { noun } })}
                    />
                    <OverrideField
                      label={t("workshop-frontend.AdminFormatsPanel.plural")}
                      value={format.output?.plural ?? format.overrides?.plural ?? ''}
                      declared={format.declared?.plural}
                      disabled={busy}
                      onCommit={(plural) => onPatch({ overrides: { plural } })}
                    />
                  </div>

                  {/* The icon also decides the thumbnail drawing, so show the drawing next to the
                      picker: choosing "table" over "presentation" changes what these look like on
                      the Outputs page, and that shouldn't be discovered there. */}
                  <figure className="hidden shrink-0 flex-col items-center gap-1.5 sm:flex">
                    <FormatPreview output={format.output} width={112} />
                    <figcaption className="text-[10px] uppercase tracking-[0.06em] text-kumo-inactive">
                      {t("workshop-frontend.AdminFormatsPanel.on_outputs")}</figcaption>
                  </figure>
                </div>
              </Fieldset>

              <Fieldset
                title={t("workshop-frontend.AdminFormatsPanel.how_the_agent_picks_it")}
                detail={t("workshop-frontend.AdminFormatsPanel.standard_formats_are_listed_first_in_the_agent_s_catalog_as_the_e")}
              >
                <OverrideField
                  label={t("workshop-frontend.AdminFormatsPanel.hint")}
                  placeholder={t("workshop-frontend.AdminFormatsPanel.e_g_prefer_for_customer_facing_decks")}
                  value={format.agentHint}
                  disabled={busy}
                  onCommit={(agentHint) => onPatch({ agentHint: agentHint ?? '' })}
                />
                {/* The literal catalog entry, including the blueprint's own description: the hint is
                    only its last line, and showing the label alone made an empty hint look like the
                    agent had been told nothing. Mirrors #listStandardFormats in overseer.ts. */}
                {format.output && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-md bg-kumo-tint/60 px-2.5 py-2 font-mono text-[11px] leading-4 text-kumo-subtle">
                    <Sparkle size={12} className="mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block">
                        {renderTranslation(t("workshop-frontend.AdminFormatsPanel.a_standard_format_on_this_deployment_2"), { noun: format.output.noun, value: format.agentHint ? ` -- ${format.agentHint}` : '' })}</span>
                      {format.blueprintDescription && (
                        <span className="mt-0.5 block text-kumo-inactive">
                          {format.blueprintDescription}
                        </span>
                      )}
                    </span>
                  </p>
                )}
              </Fieldset>

              {/* A bundled format has no remove button: the deployment put the entry there, so
                  withdrawing it is the switch above, which keeps the name, hint and position for
                  when it comes back. Removing would discard all three to reach the same visible
                  result. The backend refuses it too -- this is an RPC. */}
              <div className="flex items-end justify-between gap-4 border-t border-kumo-line pt-3">
                <p className="text-[12px] leading-4 text-kumo-subtle">
                  {format.enabled
                    ? t(format.bundled ? "workshop-frontend.AdminFormatsPanel.turning_this_off_removes_it_from_the_menus_above_and_from_the_age" : "workshop-frontend.AdminFormatsPanel.turning_this_off_removes_it_from_the_menus_above_and_from_the_ag")
                    : t(format.bundled ? "workshop-frontend.AdminFormatsPanel.currently_hidden_from_the_menus_above_and_from_the_agent_s_catalo" : "workshop-frontend.AdminFormatsPanel.currently_hidden_from_the_menus_above_and_from_the_agent_s_catal")}
                </p>
                {!format.bundled && (
                  <Button variant="secondary" disabled={busy} onClick={onRemove}>
                    <Trash size={13} className="mr-1.5" />{t("workshop-frontend.AdminFormatsPanel.stop_offering")}</Button>
                )}
              </div>
            </>
          )}

          {format.missing && (
            <div className="flex justify-end">
              <Button variant="secondary" disabled={busy} onClick={onRemove}>
                <Trash size={13} className="mr-1.5" />{t("workshop-frontend.Inbox.remove")}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Fieldset({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children: React.ReactNode
}) {
  useTranslation();
  return (
    <div>
      <p className="text-[13px] font-medium text-kumo-default">{title}</p>
      <p className="mb-2 mt-0.5 text-[12px] leading-4 text-kumo-subtle">{detail}</p>
      {children}
    </div>
  )
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warn' }) {
  useTranslation();
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${
        tone === 'warn' ? 'bg-kumo-danger/10 text-kumo-danger' : 'bg-kumo-fill text-kumo-subtle'
      }`}
    >
      {children}
    </span>
  )
}

// A field that either overrides the blueprint or defers to it. Committing an empty value, or one
// equal to the blueprint's, sends null to clear the override rather than freezing today's
// blueprint text into the config.
function OverrideField({
  label,
  value,
  declared,
  placeholder,
  disabled,
  onCommit,
}: {
  label: string
  value: string
  declared?: string
  placeholder?: string
  disabled?: boolean
  onCommit: (value: string | null) => void
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed === value.trim()) return
    onCommit(!trimmed || trimmed === declared ? null : trimmed)
  }

  const overridden = declared !== undefined && draft.trim() !== '' && draft.trim() !== declared

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        {label}
        {overridden && (
          <span className="ml-1 normal-case tracking-normal text-kumo-subtle">{t("workshop-frontend.AdminFormatsPanel.overridden")}</span>
        )}
      </span>
      <Input
        value={draft}
        placeholder={placeholder ?? declared}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
    </label>
  )
}

function IconPicker({
  icon: selected,
  declaredIcon,
  disabled,
  onPick,
}: {
  // The icon in effect, which the admin may have set on a format whose presentation is otherwise
  // still incomplete.
  icon?: OutputIcon
  declaredIcon?: OutputIcon
  disabled?: boolean
  onPick: (icon: OutputIcon | null) => void
}) {
  const { t } = useTranslation();
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        {t("workshop-frontend.AdminFormatsPanel.icon")}</span>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              disabled={disabled}
              aria-label={t("workshop-frontend.AdminFormatsPanel.choose_icon")}
              className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg border border-kumo-line bg-kumo-base text-kumo-subtle transition-colors hover:text-kumo-default disabled:cursor-default"
            >
              <FormatGlyph output={selected && { ...GENERIC_OUTPUT, icon: selected }} size="lg" />
            </button>
          }
        />
        <DropdownMenu.Content className={MENU_CONTENT}>
          <div className="grid grid-cols-5 gap-1 p-1">
            {OUTPUT_ICONS.map((icon) => {
              const Icon = FORMAT_ICONS[icon]
              const active = selected === icon
              return (
                <button
                  key={icon}
                  type="button"
                  aria-label={icon}
                  onClick={() => onPick(icon === declaredIcon ? null : icon)}
                  className={`grid h-8 w-8 cursor-pointer place-items-center rounded-md transition-colors ${
                    active ? 'bg-kumo-fill text-kumo-strong' : 'text-kumo-subtle hover:bg-kumo-tint'
                  }`}
                >
                  <Icon size={16} />
                </button>
              )
            })}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu>
    </label>
  )
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  useTranslation();
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-fill hover:text-kumo-default disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  )
}
