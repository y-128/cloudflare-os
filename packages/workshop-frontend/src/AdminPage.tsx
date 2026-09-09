import { t, useTranslation, renderTranslation, getLocale } from "@gadgets/i18n";
import { useState, useEffect, useRef, type ChangeEvent } from 'react'
import { RpcStub } from 'capnweb'
import { Switch, Textarea, Input, Button, Tabs, useKumoToastManager } from '@cloudflare/kumo'
import { Hexagon, ShieldWarning, UserPlus } from '@phosphor-icons/react'
import { useAuthenticatedApi } from './AuthContext'
import { AdminApi, AdminFormat, AdminResourceVendor, AmbientGatekeeperMode, MAX_INSTANCE_INSTRUCTIONS_LENGTH, MAX_ANNOUNCEMENT_LENGTH, MAX_SITE_NAME_LENGTH, DEFAULT_SITE_NAME, BannerColor, BANNER_COLORS, DEFAULT_BANNER_COLOR } from '@gadgets/workshop-shared/api'
import { applyAccentColor, DEFAULT_ACCENT_COLOR } from './theme'
import { cacheBustSiteLogoUrl, prepareSiteLogo } from './siteLogoUtils'
import SiteLogo from './components/SiteLogo'
import { useDocumentTitle } from './useDocumentTitle'
import AdminFormatsPanel from './components/format/AdminFormatsPanel'

// Preset accent colors offered in the Theme section ('' = default brand).
const ACCENT_PRESETS: { label: string; value: string }[] = [
  { get label() { return t("workshop-frontend.AdminPage.default"); }, value: '' },
  { get label() { return t("workshop-frontend.AdminPage.blue"); }, value: '#3b82f6' },
  { get label() { return t("workshop-frontend.AdminPage.green"); }, value: '#16a34a' },
  { get label() { return t("workshop-frontend.AdminPage.purple"); }, value: '#7c3aed' },
  { get label() { return t("workshop-frontend.AdminPage.pink"); }, value: '#db2777' },
  { get label() { return t("workshop-frontend.AdminPage.teal"); }, value: '#0d9488' },
]

// Swatch background per banner color, matching AnnouncementBanner's accent styles.
const BANNER_SWATCH: Record<BannerColor, string> = {
  neutral: 'var(--color-kumo-tint)',
  info: 'var(--color-kumo-info)',
  success: 'var(--color-kumo-success)',
  warning: 'var(--color-kumo-warning)',
  danger: 'var(--color-kumo-danger)',
  brand: 'var(--color-accent-100)',
}

export default function AdminPage() {
  const { t } = useTranslation();
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  useDocumentTitle(t("workshop-frontend.AdminPage.admin"))

  // The admin capability (minted once via getAdminApi; null until loaded / for non-admins). Wrapped
  // in an object so useState doesn't treat the (callable) RPC stub as a state updater function.
  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // System-prompt instructions: last-saved value + current editor draft.
  const [savedInstructions, setSavedInstructions] = useState('')
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [savingInstructions, setSavingInstructions] = useState(false)

  // Top-bar notice: last-saved value + current editor draft.
  const [savedAnnouncement, setSavedAnnouncement] = useState('')
  const [announcementDraft, setAnnouncementDraft] = useState('')
  const [savingAnnouncement, setSavingAnnouncement] = useState(false)

  // Full-width banner: last-saved value + current editor draft (text + accent color).
  const [savedBanner, setSavedBanner] = useState<{ text: string; color: BannerColor }>({ text: '', color: DEFAULT_BANNER_COLOR })
  const [bannerTextDraft, setBannerTextDraft] = useState('')
  const [bannerColorDraft, setBannerColorDraft] = useState<BannerColor>(DEFAULT_BANNER_COLOR)
  const [savingBanner, setSavingBanner] = useState(false)

  // Accent (brand) color: '' means the default theme. Live-previewed while editing.
  const [savedAccent, setSavedAccent] = useState('')
  const [accentDraft, setAccentDraft] = useState('')
  const [savingAccent, setSavingAccent] = useState(false)

  // Site name (shown next to the top-bar logo): last-saved value + current editor draft.
  const [savedSiteName, setSavedSiteName] = useState('')
  const [siteNameDraft, setSiteNameDraft] = useState('')
  const [savingSiteName, setSavingSiteName] = useState(false)

  // Current custom logo URL. Uploads are normalized to PNG before crossing the RPC boundary.
  const [siteLogoUrl, setSiteLogoUrl] = useState<string | null>(null)
  const [savingSiteLogo, setSavingSiteLogo] = useState(false)
  const siteLogoInputRef = useRef<HTMLInputElement>(null)

  // Whether new account signups are allowed.
  const [signupsEnabled, setSignupsEnabled] = useState(true)
  const [savingSignups, setSavingSignups] = useState(false)

  // Gatekeeper resource config, and the set of resource keys ("vendorId\u0000urlPattern") busy toggling.
  const [resourceVendors, setResourceVendors] = useState<AdminResourceVendor[]>([])
  const [resourceBusy, setResourceBusy] = useState<Set<string>>(new Set())

  const [activeTab, setActiveTab] = useState('general')

  // Promoted output formats, in menu order (see AdminFormatsPanel).
  const [formats, setFormats] = useState<AdminFormat[]>([])

  const resourceKey = (vendorId: string, urlPattern: string) => `${vendorId}\u0000${urlPattern}`

  // Populate all editor state from a freshly-fetched settings view.
  const applySettings = (view: Awaited<ReturnType<RpcStub<AdminApi>['getSettings']>>) => {
    setSignupsEnabled(view.signupsEnabled)
    setSavedSiteName(view.siteName)
    setSiteNameDraft(view.siteName)
    setSiteLogoUrl(view.siteLogo?.url ?? null)
    setResourceVendors(view.resourceVendors)
    setSavedInstructions(view.instanceInstructions)
    setInstructionsDraft(view.instanceInstructions)
    setSavedAnnouncement(view.announcement)
    setAnnouncementDraft(view.announcement)
    setSavedBanner(view.banner)
    setBannerTextDraft(view.banner.text)
    setBannerColorDraft(view.banner.color)
    setSavedAccent(view.accentColor)
    setAccentDraft(view.accentColor)
    setFormats(view.formats)
  }

  // Mint the admin capability once (the access check happens server-side) and load settings.
  useEffect(() => {
    if (!isAdmin) {
      setLoading(false)
      return
    }
    let cancelled = false
    let stub: RpcStub<AdminApi> | null = null
    ;(async () => {
      try {
        const api = await authenticatedApi.getAdminApi()
        if (cancelled) {
          api?.[Symbol.dispose]?.()
          return
        }
        if (!api) {
          setLoadError(true)
          return
        }
        stub = api
        setAdmin({ api })
        applySettings(await api.getSettings())
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load admin settings:', err)
          setLoadError(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      stub?.[Symbol.dispose]?.()
    }
  }, [isAdmin, authenticatedApi])

  // Live-preview the draft accent color across the whole app while the admin page is open. On leave
  // (or before each change) revert to the last-saved value so an unsaved preview doesn't stick.
  useEffect(() => {
    applyAccentColor(accentDraft)
    return () => { applyAccentColor(savedAccent) }
  }, [accentDraft, savedAccent])

  // Re-fetch just the gatekeeper/resource state (used to revert an optimistic toggle on error).
  // Leaves the General-tab drafts untouched.
  const reloadResources = async () => {
    if (!admin) return
    const view = await admin.api.getSettings()
    setResourceVendors(view.resourceVendors)
  }

  const handleResourceToggle = async (vendorId: string, urlPattern: string, enabled: boolean) => {
    if (!admin) return
    const key = resourceKey(vendorId, urlPattern)
    setResourceBusy((prev) => new Set(prev).add(key))
    // Optimistic update.
    setResourceVendors((prev) =>
      prev.map((v) =>
        v.vendorId !== vendorId || v.autoProvisions
          ? v
          : { ...v, resources: v.resources.map((r) => (r.urlPattern === urlPattern ? { ...r, enabled } : r)) }
      )
    )
    try {
      await admin.api.setResourceEnabled(vendorId, urlPattern, enabled)
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.update_failed")
      toasts.add({ title: message, variant: 'error' })
      await reloadResources().catch(() => {})
    } finally {
      setResourceBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleGatekeeperToggle = async (vendorId: string, enabled: boolean) => {
    if (!admin) return
    const key = `gk\u0000${vendorId}`
    setResourceBusy((prev) => new Set(prev).add(key))
    setResourceVendors((prev) =>
      prev.map((v) => (v.vendorId === vendorId && !v.autoProvisions ? { ...v, enabled } : v))
    )
    try {
      await admin.api.setGatekeeperMode(vendorId, enabled ? 'enabled' : 'disabled')
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.update_failed")
      toasts.add({ title: message, variant: 'error' })
      await reloadResources().catch(() => {})
    } finally {
      setResourceBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleGatekeeperMode = async (vendorId: string, mode: AmbientGatekeeperMode) => {
    if (!admin) return
    const key = `gk\u0000${vendorId}`
    setResourceBusy((prev) => new Set(prev).add(key))
    setResourceVendors((prev) =>
      prev.map((v) => (v.vendorId === vendorId && v.autoProvisions ? { ...v, ambientMode: mode } : v))
    )
    try {
      await admin.api.setGatekeeperMode(vendorId, mode)
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.update_failed")
      toasts.add({ title: message, variant: 'error' })
      await reloadResources().catch(() => {})
    } finally {
      setResourceBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleSaveAnnouncement = async () => {
    if (!admin) return
    setSavingAnnouncement(true)
    try {
      await admin.api.setAnnouncement(announcementDraft)
      setSavedAnnouncement(announcementDraft)
      toasts.add({ title: t("workshop-frontend.AdminPage.announcement_saved"), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.failed_to_save_announcement")
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingAnnouncement(false)
    }
  }

  const bannerDirty =
    bannerTextDraft !== savedBanner.text || bannerColorDraft !== savedBanner.color

  const handleSaveBanner = async () => {
    if (!admin) return
    setSavingBanner(true)
    try {
      await admin.api.setBanner(bannerTextDraft, bannerColorDraft)
      setSavedBanner({ text: bannerTextDraft, color: bannerColorDraft })
      toasts.add({ title: t("workshop-frontend.AdminPage.banner_saved"), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.failed_to_save_banner")
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingBanner(false)
    }
  }

  const accentDirty = accentDraft !== savedAccent

  const handleSaveAccent = async () => {
    if (!admin) return
    setSavingAccent(true)
    try {
      await admin.api.setAccentColor(accentDraft)
      setSavedAccent(accentDraft)
      toasts.add({ title: t("workshop-frontend.AdminPage.accent_color_saved"), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.failed_to_save_accent_color")
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingAccent(false)
    }
  }

  const handleSignupsToggle = async (enabled: boolean) => {
    if (!admin) return
    setSavingSignups(true)
    setSignupsEnabled(enabled) // optimistic
    try {
      await admin.api.setSignupsEnabled(enabled)
    } catch (err) {
      setSignupsEnabled(!enabled) // revert
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.update_failed")
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSignups(false)
    }
  }

  const handleSaveSiteName = async () => {
    if (!admin) return
    setSavingSiteName(true)
    try {
      await admin.api.setSiteName(siteNameDraft)
      setSavedSiteName(siteNameDraft)
      toasts.add({ title: t("workshop-frontend.AdminPage.site_name_saved"), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.failed_to_save_site_name")
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSiteName(false)
    }
  }

  const handleSiteLogoChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !admin) return

    setSavingSiteLogo(true)
    try {
      const data = await prepareSiteLogo(file)
      const logo = await admin.api.setSiteLogo(data)
      setSiteLogoUrl(logo ? cacheBustSiteLogoUrl(logo.url) : null)
      toasts.add({ title: t("workshop-frontend.AdminPage.logo_saved"), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.failed_to_save_logo")
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSiteLogo(false)
    }
  }

  const handleRemoveSiteLogo = async () => {
    if (!admin) return
    setSavingSiteLogo(true)
    try {
      await admin.api.setSiteLogo(null)
      setSiteLogoUrl(null)
      toasts.add({ title: t("workshop-frontend.AdminPage.default_logo_restored"), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.failed_to_remove_logo")
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingSiteLogo(false)
    }
  }

  const handleSaveInstructions = async () => {
    if (!admin) return
    setSavingInstructions(true)
    try {
      await admin.api.setInstanceInstructions(instructionsDraft)
      setSavedInstructions(instructionsDraft)
      toasts.add({ title: t("workshop-frontend.AdminPage.system_prompt_instructions_saved"), variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : t("workshop-frontend.AdminPage.failed_to_save_instructions")
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingInstructions(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 text-center">
        <ShieldWarning size={32} className="mx-auto text-kumo-subtle mb-3" />
        <p className="text-sm text-kumo-default">{t("workshop-frontend.AdminPage.you_don_t_have_access_to_this_page")}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <p className="text-kumo-subtle">{t("workshop-frontend.AdminPage.loading_admin_settings")}</p>
      </div>
    )
  }

  if (loadError || !admin) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-danger">{t("workshop-frontend.AdminPage.something_went_wrong_loading_admin_settings")}</p>
        <button onClick={() => window.location.reload()} className="text-kumo-brand mt-2 text-sm underline">
          {t("workshop-frontend.AdminPage.try_again")}</button>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-kumo-default">{t("workshop-frontend.AdminPage.admin")}</h1>
        <p className="text-sm text-kumo-subtle mt-1">
          {t("workshop-frontend.AdminPage.deployment_wide_settings_changes_apply_to_all_users_on_their_nex")}</p>
      </div>

      <Tabs
        variant="underline"
        value={activeTab}
        onValueChange={setActiveTab}
        tabs={[
          { value: 'general', label: t("workshop-frontend.AdminPage.general") },
          { value: 'gatekeepers', label: t("workshop-frontend.AdminPage.gatekeepers") },
          { value: 'formats', label: t("workshop-frontend.AdminPage.formats") },
          { value: 'access', label: t("gatekeeper-context.ContextLibraryPage.access") },
        ]}
      />

      {/* Standard output formats */}
      {activeTab === 'formats' && admin && (
        <AdminFormatsPanel
          admin={admin.api}
          formats={formats}
          onChanged={async () => { setFormats((await admin.api.getSettings()).formats) }}
        />
      )}

      {/* Sign-ups */}
      {activeTab === 'access' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <div className="flex items-center gap-4">
            <div className="w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center bg-kumo-tint">
              <UserPlus size={18} className="text-kumo-subtle" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-kumo-strong">{t("workshop-frontend.AdminPage.allow_new_sign_ups")}</h2>
              <p className="text-sm text-kumo-subtle mt-0.5">
                {t("workshop-frontend.AdminPage.when_off_existing_users_can_still_log_in_but_no_new_accounts_can")}</p>
            </div>
            <Switch
              checked={signupsEnabled}
              disabled={savingSignups}
              onCheckedChange={handleSignupsToggle}
            />
          </div>
        </div>
      )}

      {/* Site name */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t("workshop-frontend.AdminPage.site_name")}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {renderTranslation(t("workshop-frontend.AdminPage.shown_next_to_the_logo_in_the_top_bar_leave_empty_to_use_the_defa"), { DEFAULT_SITE_NAME: DEFAULT_SITE_NAME })}</p>

          <Input
            value={siteNameDraft}
            onChange={(e) => setSiteNameDraft(e.target.value)}
            placeholder={DEFAULT_SITE_NAME}
            maxLength={MAX_SITE_NAME_LENGTH}
          />

          <div className="flex items-center justify-end mt-4 gap-2">
            {siteNameDraft !== savedSiteName && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSiteNameDraft(savedSiteName)}
                disabled={savingSiteName}
              >
                {t("workshop-frontend.AdminPage.reset")}</Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveSiteName}
              loading={savingSiteName}
              disabled={siteNameDraft === savedSiteName}
            >
              {t("workshop-frontend.AdminPage.save")}</Button>
          </div>
        </div>
      )}

      {/* Site logo */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t("workshop-frontend.AdminPage.logo")}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t("workshop-frontend.AdminPage.shown_in_the_app_chrome_sign_in_screens_and_browser_tab_images_ar")}</p>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-kumo-line bg-kumo-base p-2">
              <SiteLogo size={40} srcOverride={siteLogoUrl}>
                <Hexagon size={32} weight="bold" className="text-kumo-brand" />
              </SiteLogo>
            </div>
            <input
              ref={siteLogoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              disabled={savingSiteLogo}
              onChange={handleSiteLogoChange}
            />
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => siteLogoInputRef.current?.click()}
                loading={savingSiteLogo}
                disabled={savingSiteLogo}
              >
                {siteLogoUrl ? t("workshop-frontend.AdminPage.change_logo") : t("workshop-frontend.AdminPage.upload_logo")}
              </Button>
              {siteLogoUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRemoveSiteLogo}
                  disabled={savingSiteLogo}
                >
                  {t("workshop-frontend.AdminPage.restore_default")}</Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Theme / accent color */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t("workshop-frontend.AdminPage.theme")}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t("workshop-frontend.AdminPage.accent_color_used_for_buttons_links_and_highlights_changes_previe")}</p>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            {ACCENT_PRESETS.map((preset) => {
              const selected = accentDraft === preset.value
              const swatch = preset.value || DEFAULT_ACCENT_COLOR
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setAccentDraft(preset.value)}
                  className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                    selected
                      ? 'border-kumo-default text-kumo-default bg-kumo-tint'
                      : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint'
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded-full border border-kumo-line"
                    style={{ background: swatch }}
                  />
                  {preset.label}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-kumo-default cursor-pointer">
              <input
                type="color"
                value={accentDraft || DEFAULT_ACCENT_COLOR}
                onChange={(e) => setAccentDraft(e.target.value)}
                className="w-9 h-9 rounded-md border border-kumo-line bg-transparent cursor-pointer p-0.5"
              />{t("workshop-frontend.AdminPage.custom")}</label>
            <span className="text-xs font-mono text-kumo-subtle">
              {accentDraft || t("workshop-frontend.AdminPage.default_2", { value1: DEFAULT_ACCENT_COLOR })}
            </span>
            <div className="flex-1" />
            {accentDirty && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAccentDraft(savedAccent)}
                disabled={savingAccent}
              >
                {t("workshop-frontend.AdminPage.reset")}</Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveAccent}
              loading={savingAccent}
              disabled={!accentDirty}
            >
              {t("workshop-frontend.AdminPage.save")}</Button>
          </div>
        </div>
      )}

      {/* Full-width banner */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t("workshop-frontend.AdminPage.banner")}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t("workshop-frontend.AdminPage.a_dismissible_bar_across_the_very_top_of_the_app_logged_in_or_not")}</p>

          <Textarea
            className="w-full"
            value={bannerTextDraft}
            onValueChange={setBannerTextDraft}
            rows={1}
            placeholder={t("workshop-frontend.AdminPage.e_g_new_blueprints_now_support_imports_learn_more_https_example")}
            maxLength={MAX_ANNOUNCEMENT_LENGTH}
            error={
              bannerTextDraft.length > MAX_ANNOUNCEMENT_LENGTH
                ? `Too long by ${bannerTextDraft.length - MAX_ANNOUNCEMENT_LENGTH} characters`
                : undefined
            }
          />

          <div className="mt-4 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-kumo-subtle mb-2">{t("workshop-frontend.AdminPage.type")}</p>
              <div className="flex flex-wrap items-center gap-2">
                {BANNER_COLORS.map((c) => {
                  const selected = bannerColorDraft === c
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setBannerColorDraft(c)}
                      className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                        selected
                          ? 'border-kumo-default text-kumo-default bg-kumo-tint'
                          : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint'
                      }`}
                    >
                      <span
                        className="w-4 h-4 rounded-full border border-kumo-line"
                        style={{ background: BANNER_SWATCH[c] }}
                      />
                      {c.charAt(0).toUpperCase() + c.slice(1)}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {bannerDirty && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setBannerTextDraft(savedBanner.text)
                    setBannerColorDraft(savedBanner.color)
                  }}
                  disabled={savingBanner}
                >
                  {t("workshop-frontend.AdminPage.reset")}</Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveBanner}
                loading={savingBanner}
                disabled={!bannerDirty || bannerTextDraft.length > MAX_ANNOUNCEMENT_LENGTH}
              >
                {t("workshop-frontend.AdminPage.save")}</Button>
            </div>
          </div>
        </div>
      )}

      {/* Top-bar notice */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t("workshop-frontend.AdminPage.top_bar_notice")}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t("workshop-frontend.AdminPage.shown_centered_in_the_top_navigation_bar_markdown_is_supported_so")}</p>

          <Textarea
            className="w-full"
            value={announcementDraft}
            onValueChange={setAnnouncementDraft}
            rows={1}
            placeholder={t("workshop-frontend.AdminPage.e_g_heads_up_scheduled_maintenance_saturday_see_status_https_sta")}
            maxLength={MAX_ANNOUNCEMENT_LENGTH}
            error={
              announcementDraft.length > MAX_ANNOUNCEMENT_LENGTH
                ? `Too long by ${announcementDraft.length - MAX_ANNOUNCEMENT_LENGTH} characters`
                : undefined
            }
          />

          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-kumo-subtle">
              {renderTranslation(t("workshop-frontend.AdminPage.characters_3"), { value: announcementDraft.length.toLocaleString(getLocale()), value1: MAX_ANNOUNCEMENT_LENGTH.toLocaleString(getLocale()) })}</span>
            <div className="flex items-center gap-2">
              {announcementDraft !== savedAnnouncement && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAnnouncementDraft(savedAnnouncement)}
                  disabled={savingAnnouncement}
                >
                  {t("workshop-frontend.AdminPage.reset")}</Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveAnnouncement}
                loading={savingAnnouncement}
                disabled={
                  announcementDraft === savedAnnouncement ||
                  announcementDraft.length > MAX_ANNOUNCEMENT_LENGTH
                }
              >
                {t("workshop-frontend.AdminPage.save")}</Button>
            </div>
          </div>
        </div>
      )}

      {/* Agent system prompt additions */}
      {activeTab === 'general' && (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t("workshop-frontend.AdminPage.agent_instructions")}</h2>
        <p className="text-sm text-kumo-subtle mb-5">
          {t("workshop-frontend.AdminPage.extra_instructions_added_to_every_agent_s_system_prompt_on_this_d")}</p>

        <Textarea
          className="w-full"
          value={instructionsDraft}
          onValueChange={setInstructionsDraft}
          rows={6}
          placeholder={t("workshop-frontend.AdminPage.e_g_acme_corp_is_a_logistics_company_that_helps_small_businesses")}
          maxLength={MAX_INSTANCE_INSTRUCTIONS_LENGTH}
          error={
            instructionsDraft.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH
              ? `Too long by ${instructionsDraft.length - MAX_INSTANCE_INSTRUCTIONS_LENGTH} characters`
              : undefined
          }
        />

        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-kumo-subtle">
            {renderTranslation(t("workshop-frontend.AdminPage.characters_3"), { value: instructionsDraft.length.toLocaleString(getLocale()), value1: MAX_INSTANCE_INSTRUCTIONS_LENGTH.toLocaleString(getLocale()) })}</span>
          <div className="flex items-center gap-2">
            {instructionsDraft !== savedInstructions && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setInstructionsDraft(savedInstructions)}
                disabled={savingInstructions}
              >
                {t("workshop-frontend.AdminPage.reset")}</Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveInstructions}
              loading={savingInstructions}
              disabled={
                instructionsDraft === savedInstructions ||
                instructionsDraft.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH
              }
            >
              {t("workshop-frontend.AdminPage.save")}</Button>
          </div>
        </div>
      </div>
      )}

      {/* Gatekeeper resources */}
      {activeTab === 'gatekeepers' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">{t("workshop-frontend.AdminPage.gatekeepers")}</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            {t("workshop-frontend.AdminPage.turn_connectors_and_resource_types_on_or_off_for_each_service_aut")}</p>

          {resourceVendors.length === 0 && (
            <p className="text-sm text-kumo-subtle">
              {t("workshop-frontend.AdminPage.no_configurable_gatekeepers_are_installed_on_this_deployment")}</p>
          )}

          <div className="space-y-6">
            {resourceVendors.map((vendor) => {
              const gkKey = `gk\u0000${vendor.vendorId}`

              // Auto-provisioned ("ambient") gatekeepers use a three-state mode and have no resources.
              if (vendor.autoProvisions) {
                const mode = vendor.ambientMode ?? 'optional'
                const options: { value: AmbientGatekeeperMode; label: string; hint: string }[] = [
                  { value: 'disabled', label: t("workshop-frontend.AdminPage.disabled"), hint: t("workshop-frontend.AdminPage.off_for_everyone") },
                  { value: 'optional', label: t("workshop-frontend.AdminPage.optional"), hint: t("workshop-frontend.AdminPage.users_can_add_it_themselves") },
                  { value: 'enabled', label: t("workshop-frontend.AdminPage.enabled"), hint: t("workshop-frontend.AdminPage.on_for_everyone_automatically") },
                ]
                return (
                  <div key={vendor.vendorId}>
                    <div className="flex items-center gap-3 mb-2 px-3 py-2 rounded-lg bg-kumo-tint/50">
                      {vendor.logo && (
                        <img
                          src={vendor.logo.url}
                          alt=""
                          className={`w-5 h-5 object-contain transition-[filter,opacity] ${mode === 'disabled' ? 'grayscale opacity-40' : ''}`}
                        />
                      )}
                      <h3 className={`flex-1 text-sm font-semibold ${mode === 'disabled' ? 'text-kumo-subtle' : 'text-kumo-default'}`}>
                        {vendor.displayName}
                      </h3>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
                        {t("workshop-frontend.AdminPage.auto_provisioned")}</span>
                    </div>
                    <div className="flex gap-2 px-3 py-1">
                      {options.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={resourceBusy.has(gkKey)}
                          onClick={() => handleGatekeeperMode(vendor.vendorId, opt.value)}
                          className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                            mode === opt.value
                              ? 'border-kumo-brand bg-kumo-brand/10'
                              : 'border-kumo-line hover:bg-kumo-tint'
                          }`}
                        >
                          <span className="block text-sm font-medium text-kumo-default">{opt.label}</span>
                          <span className="block text-xs text-kumo-subtle mt-0.5">{opt.hint}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              }

              return (
              <div key={vendor.vendorId}>
                {/* The whole header row is a toggle target; the Switch stops propagation so it
                    doesn't double-fire. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => !resourceBusy.has(gkKey) && handleGatekeeperToggle(vendor.vendorId, !vendor.enabled)}
                  onKeyDown={(e) => {
                    if (e.currentTarget !== e.target) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (!resourceBusy.has(gkKey)) handleGatekeeperToggle(vendor.vendorId, !vendor.enabled)
                    }
                  }}
                  className="flex cursor-pointer items-center gap-3 mb-2 px-3 py-2 rounded-lg bg-kumo-tint/50 hover:bg-kumo-tint transition-colors"
                >
                  {vendor.logo && (
                    <img
                      src={vendor.logo.url}
                      alt=""
                      className={`w-5 h-5 object-contain transition-[filter,opacity] ${vendor.enabled ? '' : 'grayscale opacity-40'}`}
                    />
                  )}
                  <h3 className={`flex-1 text-sm font-semibold ${vendor.enabled ? 'text-kumo-default' : 'text-kumo-subtle'}`}>
                    {vendor.displayName}
                    {!vendor.enabled && (
                      <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-kumo-tint text-kumo-subtle border border-kumo-line">
                        {t("workshop-frontend.AdminPage.disabled_2")}</span>
                    )}
                  </h3>
                  <span className="text-xs text-kumo-subtle">
                    {vendor.enabled ? t("workshop-frontend.AdminPage.enabled") : t("workshop-frontend.AdminPage.off")}
                  </span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={vendor.enabled}
                      disabled={resourceBusy.has(gkKey)}
                      onCheckedChange={(enabled) => handleGatekeeperToggle(vendor.vendorId, enabled)}
                    />
                  </span>
                </div>
                {/* Resources are hidden while the gatekeeper is disabled — they can't be used
                    until it's re-enabled. */}
                {vendor.enabled ? (
                  <div className="space-y-1">
                    {vendor.resources.map((resource) => {
                      const key = resourceKey(vendor.vendorId, resource.urlPattern)
                      return (
                        <div
                          key={resource.urlPattern}
                          role="button"
                          tabIndex={0}
                          onClick={() => !resourceBusy.has(key) && handleResourceToggle(vendor.vendorId, resource.urlPattern, !resource.enabled)}
                          onKeyDown={(e) => {
                            if (e.currentTarget !== e.target) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              if (!resourceBusy.has(key)) handleResourceToggle(vendor.vendorId, resource.urlPattern, !resource.enabled)
                            }
                          }}
                          className="flex cursor-pointer items-center gap-4 px-3 py-2.5 rounded-lg hover:bg-kumo-tint transition-colors"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-kumo-default truncate">
                              {resource.title}
                            </p>
                            <p className="text-xs text-kumo-subtle mt-0.5">{resource.description}</p>
                          </div>
                          <span onClick={(e) => e.stopPropagation()}>
                            <Switch
                              checked={resource.enabled}
                              disabled={resourceBusy.has(key)}
                              onCheckedChange={(enabled) =>
                                handleResourceToggle(vendor.vendorId, resource.urlPattern, enabled)
                              }
                            />
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-kumo-subtle px-3 py-1">
                    {renderTranslation(t("workshop-frontend.AdminPage.resources_hidden_while_disabled"), { n: vendor.resources.length })}</p>
                )}
              </div>
            )})}
          </div>
        </div>
      )}
    </div>
  )
}
