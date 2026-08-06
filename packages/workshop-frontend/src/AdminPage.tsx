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
  { label: 'デフォルト', value: '' },
  { label: '青', value: '#3b82f6' },
  { label: '緑', value: '#16a34a' },
  { label: '紫', value: '#7c3aed' },
  { label: 'ピンク', value: '#db2777' },
  { label: 'ティール', value: '#0d9488' },
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
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  useDocumentTitle('管理')

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
      const message = err instanceof Error ? err.message : 'Update failed'
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
      const message = err instanceof Error ? err.message : 'Update failed'
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
      const message = err instanceof Error ? err.message : 'Update failed'
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
      toasts.add({ title: 'お知らせを保存しました', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save announcement'
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
      toasts.add({ title: 'バナーが保存されました', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save banner'
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
      toasts.add({ title: 'アクセントカラーを保存しました', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save accent color'
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
      const message = err instanceof Error ? err.message : 'Update failed'
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
      toasts.add({ title: 'サイト名が保存されました', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save site name'
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
      toasts.add({ title: 'ロゴが保存されました', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save logo'
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
      toasts.add({ title: 'デフォルトのロゴが復元されました', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove logo'
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
      toasts.add({ title: 'システムプロンプトの指示が保存されました', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save instructions'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSavingInstructions(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16 text-center">
        <ShieldWarning size={32} className="mx-auto text-kumo-subtle mb-3" />
        <p className="text-sm text-kumo-default">このページへのアクセス権がありません。</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <p className="text-kumo-subtle">管理設定を読み込んでいます...</p>
      </div>
    )
  }

  if (loadError || !admin) {
    return (
      <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-16 text-center">
        <p className="text-sm text-kumo-danger">管理者設定の読み込み中に問題が発生しました。</p>
        <button onClick={() => window.location.reload()} className="text-kumo-brand mt-2 text-sm underline">
          再試行
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 sm:px-8 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-kumo-default">管理</h1>
        <p className="text-sm text-kumo-subtle mt-1">
          デプロイメント全体の設定。変更は、次回の接続時にすべてのユーザーに適用されます。
        </p>
      </div>

      <Tabs
        variant="underline"
        value={activeTab}
        onValueChange={setActiveTab}
        tabs={[
          { value: 'general', label: 'General' },
          { value: 'gatekeepers', label: 'ゲートキーパー' },
          { value: 'formats', label: 'Formats' },
          { value: 'access', label: 'Access' },
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
              <h2 className="text-lg font-semibold text-kumo-strong">新規登録を許可</h2>
              <p className="text-sm text-kumo-subtle mt-0.5">
                オフの場合、既存のユーザーは引き続きログインできますが、新しいアカウントは作成できません。
              </p>
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
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">サイト名</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            トップバーのロゴの横に表示されます。デフォルトを使用するには空のままにしてください
            (「{DEFAULT_SITE_NAME}”)。各ユーザーの次回の接続に適用されます。
          </p>

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
                リセット
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveSiteName}
              loading={savingSiteName}
              disabled={siteNameDraft === savedSiteName}
            >
              保存
            </Button>
          </div>
        </div>
      )}

      {/* Site logo */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">ロゴ</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            アプリのクロム、サインイン画面、ブラウザーのタブに表示されます。画像は拡大縮小されません
            トリミングされ、静的 PNG に変換されます。正方形の画像が最適です。それぞれに適用されます
            ユーザーの次の接続。
          </p>

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
                {siteLogoUrl ? 'ロゴを変更' : 'ロゴをアップロード'}
              </Button>
              {siteLogoUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRemoveSiteLogo}
                  disabled={savingSiteLogo}
                >
                  デフォルトに戻す
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Theme / accent color */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">テーマ</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            ボタン、リンク、ハイライトに使用されるアクセントカラー。変更のプレビューはここで公開されています。クリック
            保存して全員に適用します (次回の接続時に)。背景はデフォルトのまま
            温かいテーマ。
          </p>

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
              />
              カスタム
            </label>
            <span className="text-xs font-mono text-kumo-subtle">
              {accentDraft || `${DEFAULT_ACCENT_COLOR} (default)`}
            </span>
            <div className="flex-1" />
            {accentDirty && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAccentDraft(savedAccent)}
                disabled={savingAccent}
              >
                リセット
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveAccent}
              loading={savingAccent}
              disabled={!accentDirty}
            >
              保存
            </Button>
          </div>
        </div>
      )}

      {/* Full-width banner */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">バナー</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            アプリの最上部にある閉じることができるバー (ログインしているかどうかに関係なく)。マークダウンとは
            サポートされているため、リンクを含めることができます。非表示にするには空のままにします。それぞれに適用されます
            ユーザーの次の接続。
          </p>

          <Textarea
            className="w-full"
            value={bannerTextDraft}
            onValueChange={setBannerTextDraft}
            rows={1}
            placeholder={'例えば🎉 新機能: ブループリントがインポートをサポートするようになりました — [詳細](https://example.com)。'}
            maxLength={MAX_ANNOUNCEMENT_LENGTH}
            error={
              bannerTextDraft.length > MAX_ANNOUNCEMENT_LENGTH
                ? `Too long by ${bannerTextDraft.length - MAX_ANNOUNCEMENT_LENGTH} characters`
                : undefined
            }
          />

          <div className="mt-4 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-kumo-subtle mb-2">種類</p>
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
                  リセット
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveBanner}
                loading={savingBanner}
                disabled={!bannerDirty || bannerTextDraft.length > MAX_ANNOUNCEMENT_LENGTH}
              >
                保存
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Top-bar notice */}
      {activeTab === 'general' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">トップバーのお知らせ</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            上部のナビゲーション バーの中央に表示されます。マークダウンがサポートされているため、含めることができます
            リンク。短くしてください。1 行で表示されます。何も表示しない場合は空のままにします。適用される
            各ユーザーの次回の接続時に。
          </p>

          <Textarea
            className="w-full"
            value={announcementDraft}
            onValueChange={setAnnouncementDraft}
            rows={1}
            placeholder={'例えば注意: 土曜日に予定されているメンテナンス — [ステータス](https://status.example.com) を参照してください。'}
            maxLength={MAX_ANNOUNCEMENT_LENGTH}
            error={
              announcementDraft.length > MAX_ANNOUNCEMENT_LENGTH
                ? `Too long by ${announcementDraft.length - MAX_ANNOUNCEMENT_LENGTH} characters`
                : undefined
            }
          />

          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-kumo-subtle">
              {announcementDraft.length.toLocaleString()} / {MAX_ANNOUNCEMENT_LENGTH.toLocaleString()} キャラクター
            </span>
            <div className="flex items-center gap-2">
              {announcementDraft !== savedAnnouncement && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAnnouncementDraft(savedAnnouncement)}
                  disabled={savingAnnouncement}
                >
                  リセット
                </Button>
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
                保存
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Agent system prompt additions */}
      {activeTab === 'general' && (
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <h2 className="text-lg font-semibold text-kumo-strong mb-1">エージェントへの指示</h2>
        <p className="text-sm text-kumo-subtle mb-5">
          この展開では、すべてのエージェントのシステム プロンプトに追加の指示が追加されました。これを使用してください
          たとえば、特定のコンテキスト、規則、ガードレールなどです。
        </p>

        <Textarea
          className="w-full"
          value={instructionsDraft}
          onValueChange={setInstructionsDraft}
          rows={6}
          placeholder={'例えばACME Corp は中小企業の配送を支援する物流会社です\n国際的に。私たちのチームは、出荷を追跡するための内部ツールとダッシュボードを構築しています。'}
          maxLength={MAX_INSTANCE_INSTRUCTIONS_LENGTH}
          error={
            instructionsDraft.length > MAX_INSTANCE_INSTRUCTIONS_LENGTH
              ? `Too long by ${instructionsDraft.length - MAX_INSTANCE_INSTRUCTIONS_LENGTH} characters`
              : undefined
          }
        />

        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-kumo-subtle">
            {instructionsDraft.length.toLocaleString()} / {MAX_INSTANCE_INSTRUCTIONS_LENGTH.toLocaleString()} キャラクター
          </span>
          <div className="flex items-center gap-2">
            {instructionsDraft !== savedInstructions && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setInstructionsDraft(savedInstructions)}
                disabled={savingInstructions}
              >
                リセット
              </Button>
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
              保存
            </Button>
          </div>
        </div>
      </div>
      )}

      {/* Gatekeeper resources */}
      {activeTab === 'gatekeepers' && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-1">ゲートキーパー</h2>
          <p className="text-sm text-kumo-subtle mb-5">
            サービスごとにコネクタとリソース タイプをオンまたはオフにします。自動プロビジョニング
            ゲートキーパー (コンテキスト ライブラリなど) には 3 つのモードがあります - 無効、オプション、または
            誰もが利用できるようになります。変更はソフトです: ガジェットへのアクセスがすでに取り消されることはありません
            が成立する。
          </p>

          {resourceVendors.length === 0 && (
            <p className="text-sm text-kumo-subtle">
              この展開には構成可能なゲートキーパーはインストールされません。
            </p>
          )}

          <div className="space-y-6">
            {resourceVendors.map((vendor) => {
              const gkKey = `gk\u0000${vendor.vendorId}`

              // Auto-provisioned ("ambient") gatekeepers use a three-state mode and have no resources.
              if (vendor.autoProvisions) {
                const mode = vendor.ambientMode ?? 'optional'
                const options: { value: AmbientGatekeeperMode; label: string; hint: string }[] = [
                  { value: 'disabled', label: '無効', hint: 'Off for everyone' },
                  { value: 'optional', label: '任意', hint: 'Users can add it themselves' },
                  { value: 'enabled', label: '有効', hint: 'On for everyone automatically' },
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
                        自動プロビジョニングされた
                      </span>
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
                        無効
                      </span>
                    )}
                  </h3>
                  <span className="text-xs text-kumo-subtle">
                    {vendor.enabled ? '有効' : 'オフ'}
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
                    {vendor.resources.length} リソース{vendor.resources.length === 1 ? '' : 's'} 無効になっている間は非表示になります。
                  </p>
                )}
              </div>
            )})}
          </div>
        </div>
      )}
    </div>
  )
}
