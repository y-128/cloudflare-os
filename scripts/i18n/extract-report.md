# Japanese localization extraction report

Source: `git diff b07016d^..b07016d`. Regenerate with `node scripts/i18n/extract-from-fork.ts`.

- Total translation pairs extracted: **1780**
- Matched positional line pairs: **1622**
- Changed lines: **1691 removed / 1691 added**
- Unmatched lines: **69 removed / 69 added**
- Supplemental entries (not extracted): **1008**

Each contiguous change run is paired positionally within its hunk. Only literal contents may differ; surrounding code, whitespace, delimiters, and literal kinds must match. JSX text is decoded as display text. Comments, interpolated templates, multiline quoted literals, structural edits, and non-Japanese replacements are never guessed. Repeated literals receive numeric key suffixes.

1691 insertions/deletions describe changed lines, not a guaranteed number of string literals. A line can contain several literals or no safely extractable literal.

Removed locations refer to the parent commit; added locations refer to the localization commit. To fill gaps, add reviewed entries to `scripts/i18n/supplemental.ts` and rerun the generator; the unmatched source evidence remains in this report.

## Unmatched lines

### removed: packages/gatekeeper-context/app/ContextLibraryPage.tsx:1688

Not exclusively English-to-Japanese literal replacements.

<pre>                  &lt;li&gt;Select Mirror specific branches and type in "{branch}"&lt;/li&gt;</pre>

### added: packages/gatekeeper-context/app/ContextLibraryPage.tsx:1688

Not exclusively English-to-Japanese literal replacements.

<pre>                  &lt;li&gt;[特定のブランチをミラーリング] を選択し、「{branch}」と入力します&lt;/li&gt;</pre>

### removed: packages/gatekeeper-context/app/ContextLibraryPage.tsx:1992

No matching single-line literal structure (including unsupported templates).

<pre>                  aria-label={`Actions for ${folder.name}`}</pre>

### added: packages/gatekeeper-context/app/ContextLibraryPage.tsx:1992

No matching single-line literal structure (including unsupported templates).

<pre>                  aria-label={`${folder.name}の操作`}</pre>

### removed: packages/gatekeeper-context/app/ContextLibraryPage.tsx:2118

No matching single-line literal structure (including unsupported templates).

<pre>              aria-label={`Actions for ${baseName(doc.path)}`}</pre>

### added: packages/gatekeeper-context/app/ContextLibraryPage.tsx:2118

No matching single-line literal structure (including unsupported templates).

<pre>              aria-label={`${baseName(doc.path)}の操作`}</pre>

### removed: packages/gatekeeper-context/app/index.html:2

Not exclusively English-to-Japanese literal replacements.

<pre>&lt;html lang="en"&gt;</pre>

### added: packages/gatekeeper-context/app/index.html:2

Not exclusively English-to-Japanese literal replacements.

<pre>&lt;html lang="ja"&gt;</pre>

### removed: packages/gatekeeper-scheduler/app/SchedulerPage.tsx:397

No matching single-line literal structure (including unsupported templates).

<pre>            aria-label={`${expanded ? "Hide" : "Show"} why ${schedule.title} needs attention`}</pre>

### added: packages/gatekeeper-scheduler/app/SchedulerPage.tsx:397

No matching single-line literal structure (including unsupported templates).

<pre>            aria-label={`${expanded ? "隠れる" : "見せる"} why ${schedule.title} needs attention`}</pre>

### removed: packages/gatekeeper-scheduler/app/index.html:2

Not exclusively English-to-Japanese literal replacements.

<pre>&lt;html lang="en"&gt;</pre>

### added: packages/gatekeeper-scheduler/app/index.html:2

Not exclusively English-to-Japanese literal replacements.

<pre>&lt;html lang="ja"&gt;</pre>

### removed: packages/workshop-frontend/index.html:2

Not exclusively English-to-Japanese literal replacements.

<pre>&lt;html lang="en"&gt;</pre>

### added: packages/workshop-frontend/index.html:2

Not exclusively English-to-Japanese literal replacements.

<pre>&lt;html lang="ja"&gt;</pre>

### removed: packages/workshop-frontend/src/Activity.tsx:167

Surrounding code, whitespace, or literal kinds differ.

<pre>      toasts.add({ title: `Failed to ${enabled ? 'enable' : 'disable'} hook`, variant: 'error' })</pre>

### added: packages/workshop-frontend/src/Activity.tsx:167

Surrounding code, whitespace, or literal kinds differ.

<pre>      toasts.add({ title: `Failed to ${enabled ? '有効にする' : '無効にする'} hook`, variant: 'error' })</pre>

### removed: packages/workshop-frontend/src/Activity.tsx:477

No matching single-line literal structure (including unsupported templates).

<pre>                    aria-label={`${entry.enabled ? 'Disable' : 'Enable'} auto-approval for ${entry.actionKind.label}`}</pre>

### added: packages/workshop-frontend/src/Activity.tsx:477

No matching single-line literal structure (including unsupported templates).

<pre>                    aria-label={`${entry.enabled ? '無効にする' : '有効にする'} auto-approval for ${entry.actionKind.label}`}</pre>

### removed: packages/workshop-frontend/src/ActivityNotifications.tsx:44

No matching single-line literal structure (including unsupported templates).

<pre>              ? `Activity — ${pending.length} ${pending.length === 1 ? 'request needs' : 'requests need'} review`</pre>

### added: packages/workshop-frontend/src/ActivityNotifications.tsx:44

No matching single-line literal structure (including unsupported templates).

<pre>              ? `Activity — ${pending.length} ${pending.length === 1 ? 'リクエストのニーズ' : 'リクエストが必要です'} review`</pre>

### removed: packages/workshop-frontend/src/AdminPage.tsx:447

No matching single-line literal structure (including unsupported templates).

<pre>            (&amp;ldquo;{DEFAULT_SITE_NAME}&amp;rdquo;). Applies on each user&amp;rsquo;s next connection.</pre>

### added: packages/workshop-frontend/src/AdminPage.tsx:447

No matching single-line literal structure (including unsupported templates).

<pre>            (「{DEFAULT_SITE_NAME}”)。各ユーザーの次回の接続に適用されます。</pre>

### removed: packages/workshop-frontend/src/AdminPage.tsx:488

No matching single-line literal structure (including unsupported templates).

<pre>            user&amp;rsquo;s next connection.</pre>

### added: packages/workshop-frontend/src/AdminPage.tsx:488

No matching single-line literal structure (including unsupported templates).

<pre>            ユーザーの次の接続。</pre>

### removed: packages/workshop-frontend/src/AdminPage.tsx:609

No matching single-line literal structure (including unsupported templates).

<pre>            user&amp;rsquo;s next connection.</pre>

### added: packages/workshop-frontend/src/AdminPage.tsx:609

No matching single-line literal structure (including unsupported templates).

<pre>            ユーザーの次の接続。</pre>

### removed: packages/workshop-frontend/src/AdminPage.tsx:689

No matching single-line literal structure (including unsupported templates).

<pre>            on each user&amp;rsquo;s next connection.</pre>

### added: packages/workshop-frontend/src/AdminPage.tsx:689

No matching single-line literal structure (including unsupported templates).

<pre>            各ユーザーの次回の接続時に。</pre>

### removed: packages/workshop-frontend/src/AdminPage.tsx:743

No matching single-line literal structure (including unsupported templates).

<pre>          Extra instructions added to every agent&amp;rsquo;s system prompt on this deployment. Use this</pre>

### added: packages/workshop-frontend/src/AdminPage.tsx:743

No matching single-line literal structure (including unsupported templates).

<pre>          この展開では、すべてのエージェントのシステム プロンプトに追加の指示が追加されました。これを使用してください</pre>

### removed: packages/workshop-frontend/src/AdminPage.tsx:799

No matching single-line literal structure (including unsupported templates).

<pre>            gatekeepers (like the Context Library) have three modes &amp;mdash; disabled, optional, or</pre>

### added: packages/workshop-frontend/src/AdminPage.tsx:799

No matching single-line literal structure (including unsupported templates).

<pre>            ゲートキーパー (コンテキスト ライブラリなど) には 3 つのモードがあります - 無効、オプション、または</pre>

### removed: packages/workshop-frontend/src/AdminPage.tsx:800

No matching single-line literal structure (including unsupported templates).

<pre>            enabled for everyone. Changes are soft: they don&amp;rsquo;t revoke access a gadget already</pre>

### added: packages/workshop-frontend/src/AdminPage.tsx:800

No matching single-line literal structure (including unsupported templates).

<pre>            誰もが利用できるようになります。変更はソフトです: ガジェットへのアクセスがすでに取り消されることはありません</pre>

### removed: packages/workshop-frontend/src/BlueprintLandingPage.tsx:1006

No matching single-line literal structure (including unsupported templates).

<pre>              &lt;button onClick={() =&gt; setError(null)} className="cursor-pointer text-kumo-danger hover:text-kumo-default"&gt;&amp;times;&lt;/button&gt;</pre>

### added: packages/workshop-frontend/src/BlueprintLandingPage.tsx:1006

No matching single-line literal structure (including unsupported templates).

<pre>              &lt;button onClick={() =&gt; setError(null)} className="cursor-pointer text-kumo-danger hover:text-kumo-default"&gt;×&lt;/button&gt;</pre>

### removed: packages/workshop-frontend/src/BlueprintLandingPage.tsx:1135

No matching single-line literal structure (including unsupported templates).

<pre>            aria-label={`Open larger screenshot of ${title}`}</pre>

### added: packages/workshop-frontend/src/BlueprintLandingPage.tsx:1135

No matching single-line literal structure (including unsupported templates).

<pre>            aria-label={`${title}のスクリーンショットを拡大表示`}</pre>

### removed: packages/workshop-frontend/src/BlueprintLandingPage.tsx:1641

Not exclusively English-to-Japanese literal replacements.

<pre>        &lt;p&gt;The "{binding.gatekeeperName}" gatekeeper is not available on this workshop, so this connection can't be configured.&lt;/p&gt;</pre>

### added: packages/workshop-frontend/src/BlueprintLandingPage.tsx:1641

Not exclusively English-to-Japanese literal replacements.

<pre>        &lt;p&gt;」{binding.gatekeeperName}「このワークショップではゲートキーパーを使用できないため、この接続を構成できません。&lt;/p&gt;</pre>

### removed: packages/workshop-frontend/src/BlueprintsPage.tsx:184

No matching single-line literal structure (including unsupported templates).

<pre>        aria-label={`Open featured blueprint ${blueprint.metadata.title}`}</pre>

### added: packages/workshop-frontend/src/BlueprintsPage.tsx:184

No matching single-line literal structure (including unsupported templates).

<pre>        aria-label={`おすすめブループリント「${blueprint.metadata.title}」を開く`}</pre>

### removed: packages/workshop-frontend/src/ChatInterface.tsx:1317

No matching single-line literal structure (including unsupported templates).

<pre>      aria-label={`Preview ${title}`}</pre>

### added: packages/workshop-frontend/src/ChatInterface.tsx:1317

No matching single-line literal structure (including unsupported templates).

<pre>      aria-label={`${title}をプレビュー`}</pre>

### removed: packages/workshop-frontend/src/ChatInterface.tsx:1388

No matching single-line literal structure (including unsupported templates).

<pre>      aria-label={`Preview ${attachment.name ?? "attached file"}`}</pre>

### added: packages/workshop-frontend/src/ChatInterface.tsx:1388

No matching single-line literal structure (including unsupported templates).

<pre>      aria-label={`${attachment.name ?? "添付ファイル"}をプレビュー`}</pre>

### removed: packages/workshop-frontend/src/ChatInterface.tsx:5699

Surrounding code, whitespace, or literal kinds differ.

<pre>      toasts.add({ title: `Failed to ${enabled ? "enable" : "disable"} hook`, variant: "error" });</pre>

### added: packages/workshop-frontend/src/ChatInterface.tsx:5699

Surrounding code, whitespace, or literal kinds differ.

<pre>      toasts.add({ title: `Failed to ${enabled ? "有効にする" : "無効にする"} hook`, variant: "error" });</pre>

### removed: packages/workshop-frontend/src/ChatInterface.tsx:6527

No matching single-line literal structure (including unsupported templates).

<pre>                            aria-label={`Rename ${chat.title}`}</pre>

### added: packages/workshop-frontend/src/ChatInterface.tsx:6527

No matching single-line literal structure (including unsupported templates).

<pre>                            aria-label={`${chat.title}の名前を変更`}</pre>

### removed: packages/workshop-frontend/src/ChatInterface.tsx:6574

No matching single-line literal structure (including unsupported templates).

<pre>                              aria-label={`Actions for ${chat.title}`}</pre>

### added: packages/workshop-frontend/src/ChatInterface.tsx:6574

No matching single-line literal structure (including unsupported templates).

<pre>                              aria-label={`${chat.title}の操作`}</pre>

### removed: packages/workshop-frontend/src/ChatInterface.tsx:6834

No matching single-line literal structure (including unsupported templates).

<pre>                                  : `The ${kept === 1 ? "message" : `${kept} messages`} after the cut ${kept === 1 ? "was" : "were"} kept in full.`}</pre>

### added: packages/workshop-frontend/src/ChatInterface.tsx:6834

No matching single-line literal structure (including unsupported templates).

<pre>                                  : `The ${kept === 1 ? "メッセージ" : `${kept} messages`} after the cut ${kept === 1 ? "は" : "は"} kept in full.`}</pre>

### removed: packages/workshop-frontend/src/Connections.tsx:94

Surrounding code, whitespace, or literal kinds differ.

<pre>      toasts.add({ title: `Failed to ${enabled ? 'enable' : 'disable'} hook`, variant: 'error' })</pre>

### added: packages/workshop-frontend/src/Connections.tsx:94

Surrounding code, whitespace, or literal kinds differ.

<pre>      toasts.add({ title: `Failed to ${enabled ? '有効にする' : '無効にする'} hook`, variant: 'error' })</pre>

### removed: packages/workshop-frontend/src/FileSidebar.tsx:368

No matching single-line literal structure (including unsupported templates).

<pre>          aria-label={`Rename ${filename}`}</pre>

### added: packages/workshop-frontend/src/FileSidebar.tsx:368

No matching single-line literal structure (including unsupported templates).

<pre>          aria-label={`${filename}の名前を変更`}</pre>

### removed: packages/workshop-frontend/src/FileSidebar.tsx:397

No matching single-line literal structure (including unsupported templates).

<pre>                aria-label={`Actions for ${filename}`}</pre>

### added: packages/workshop-frontend/src/FileSidebar.tsx:397

No matching single-line literal structure (including unsupported templates).

<pre>                aria-label={`${filename}の操作`}</pre>

### removed: packages/workshop-frontend/src/GadgetCodeInterface.tsx:886

No matching single-line literal structure (including unsupported templates).

<pre>                aria-label={`Download ${activeFile}`}</pre>

### added: packages/workshop-frontend/src/GadgetCodeInterface.tsx:886

No matching single-line literal structure (including unsupported templates).

<pre>                aria-label={`${activeFile}をダウンロード`}</pre>

### removed: packages/workshop-frontend/src/GadgetEditor.tsx:1675

No matching single-line literal structure (including unsupported templates).

<pre>                    Press &lt;kbd className="rounded border border-kumo-line bg-kumo-elevated px-1.5 py-0.5 text-[11px] font-medium"&gt;Esc&lt;/kbd&gt; to exit full screen</pre>

### added: packages/workshop-frontend/src/GadgetEditor.tsx:1675

No matching single-line literal structure (including unsupported templates).

<pre>                    &lt;kbd className="rounded border border-kumo-line bg-kumo-elevated px-1.5 py-0.5 text-[11px] font-medium"&gt;ESC&lt;/kbd&gt; を押すと全画面表示を終了します</pre>

### removed: packages/workshop-frontend/src/OnboardingWizard.tsx:658

No matching single-line literal structure (including unsupported templates).

<pre>                  Optional &amp;middot; you can manage connections any time</pre>

### added: packages/workshop-frontend/src/OnboardingWizard.tsx:658

No matching single-line literal structure (including unsupported templates).

<pre>                  オプション - いつでも接続を管理できます</pre>

### removed: packages/workshop-frontend/src/ProtectedRoute.tsx:60

No matching single-line literal structure (including unsupported templates).

<pre>          title={`Authentication error: ${error}`}</pre>

### added: packages/workshop-frontend/src/ProtectedRoute.tsx:60

No matching single-line literal structure (including unsupported templates).

<pre>          title={`認証エラー: ${error}`}</pre>

### removed: packages/workshop-frontend/src/ProtectedRoute.tsx:101

No matching single-line literal structure (including unsupported templates).

<pre>}</pre>

### added: packages/workshop-frontend/src/ProtectedRoute.tsx:101

No matching single-line literal structure (including unsupported templates).

<pre>}</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:47

No matching single-line literal structure (including unsupported templates).

<pre>  if (diffMinutes &lt; 60) return `${diffMinutes}m ago`</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:47

No matching single-line literal structure (including unsupported templates).

<pre>  if (diffMinutes &lt; 60) return `${diffMinutes}分前`</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:48

No matching single-line literal structure (including unsupported templates).

<pre>  if (diffHours &lt; 24) return `${diffHours}h ago`</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:48

No matching single-line literal structure (including unsupported templates).

<pre>  if (diffHours &lt; 24) return `${diffHours}時間前`</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:49

No matching single-line literal structure (including unsupported templates).

<pre>  if (diffDays &lt; 7) return `${diffDays}d ago`</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:49

No matching single-line literal structure (including unsupported templates).

<pre>  if (diffDays &lt; 7) return `${diffDays}日前`</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:50

No matching single-line literal structure (including unsupported templates).

<pre>  return date.toLocaleDateString()</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:50

No matching single-line literal structure (including unsupported templates).

<pre>  return date.toLocaleDateString('ja-JP')</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:254

No matching single-line literal structure (including unsupported templates).

<pre>            &lt;&gt;People with &lt;span className="font-medium text-kumo-default"&gt;{roleLabel(role)}&lt;/span&gt; access must&lt;/&gt;</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:254

No matching single-line literal structure (including unsupported templates).

<pre>            &lt;&gt;&lt;span className="font-medium text-kumo-default"&gt;{roleLabel(role)}&lt;/span&gt;権限を持つ人は&lt;/&gt;</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:255

Surrounding code, whitespace, or literal kinds differ.

<pre>          ) : 'Recipients must'} prove their own account can reach:</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:255

Surrounding code, whitespace, or literal kinds differ.

<pre>          ) : '受信者は'}、自分のアカウントで以下へアクセスできることを確認する必要があります。</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:758

Not exclusively English-to-Japanese literal replacements.

<pre>              Share “{metadata.title}”</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:758

Not exclusively English-to-Japanese literal replacements.

<pre>              「{metadata.title}」を共有</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:988

No matching single-line literal structure (including unsupported templates).

<pre>                            aria-label={`Remove ${profile.name}`}</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:988

No matching single-line literal structure (including unsupported templates).

<pre>                            aria-label={`${profile.name}さんを削除`}</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:999

No matching single-line literal structure (including unsupported templates).

<pre>                          {downstreamDependents.length} other {downstreamDependents.length === 1 ? 'person loses' : 'people lose'} access through {profile.name}. Keep anyone?</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:999

No matching single-line literal structure (including unsupported templates).

<pre>                          {profile.name}さんを削除すると、ほかの{downstreamDependents.length}人もアクセスできなくなります。アクセスを維持する人を選択してください。</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:1078

No matching single-line literal structure (including unsupported templates).

<pre>                              aria-label={`Copy ${sk.note || 'share link'}`}</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:1078

No matching single-line literal structure (including unsupported templates).

<pre>                              aria-label={`${sk.note || '共有リンク'}をコピー`}</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:1086

No matching single-line literal structure (including unsupported templates).

<pre>                              aria-label={`Rename ${sk.note || 'share link'}`}</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:1086

No matching single-line literal structure (including unsupported templates).

<pre>                              aria-label={`${sk.note || '共有リンク'}の名前を変更`}</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:1095

No matching single-line literal structure (including unsupported templates).

<pre>                              aria-label={`Revoke ${sk.note || 'share link'}`}</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:1095

No matching single-line literal structure (including unsupported templates).

<pre>                              aria-label={`${sk.note || '共有リンク'}を取り消す`}</pre>

### removed: packages/workshop-frontend/src/ShareModal.tsx:1106

No matching single-line literal structure (including unsupported templates).

<pre>                            {revokeTarget.dependents.length} {revokeTarget.dependents.length === 1 ? 'person loses' : 'people lose'} access through this link. Keep anyone?</pre>

### added: packages/workshop-frontend/src/ShareModal.tsx:1106

No matching single-line literal structure (including unsupported templates).

<pre>                            このリンクを取り消すと、{revokeTarget.dependents.length}人がアクセスできなくなります。アクセスを維持する人を選択してください。</pre>

### removed: packages/workshop-frontend/src/WorkpiecePicker.tsx:177

No matching single-line literal structure (including unsupported templates).

<pre>                  aria-label={`Rename ${gadget.title}`}</pre>

### added: packages/workshop-frontend/src/WorkpiecePicker.tsx:177

No matching single-line literal structure (including unsupported templates).

<pre>                  aria-label={`${gadget.title}の名前を変更`}</pre>

### removed: packages/workshop-frontend/src/components/AppShell/CommandPalette.tsx:421

Not exclusively English-to-Japanese literal replacements.

<pre>            &lt;kbd className="rounded border border-kumo-line px-1 py-0.5 font-sans leading-none"&gt;esc&lt;/kbd&gt;</pre>

### added: packages/workshop-frontend/src/components/AppShell/CommandPalette.tsx:421

Not exclusively English-to-Japanese literal replacements.

<pre>            &lt;kbd className="rounded border border-kumo-line px-1 py-0.5 font-sans leading-none"&gt;ESC&lt;/kbd&gt;</pre>

### removed: packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx:237

No matching single-line literal structure (including unsupported templates).

<pre>            ? `Remove "${deleteTarget?.title || 'Untitled workspace'}" from your list? You can still access it via its link.`</pre>

### added: packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx:237

No matching single-line literal structure (including unsupported templates).

<pre>            ? `Remove "${deleteTarget?.title || '無題のワークスペース'}" from your list? You can still access it via its link.`</pre>

### removed: packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx:238

No matching single-line literal structure (including unsupported templates).

<pre>            : `Delete "${deleteTarget?.title || 'Untitled workspace'}"? This cannot be undone.`</pre>

### added: packages/workshop-frontend/src/components/AppShell/SidebarWorkspaces.tsx:238

No matching single-line literal structure (including unsupported templates).

<pre>            : `Delete "${deleteTarget?.title || '無題のワークスペース'}"? This cannot be undone.`</pre>

### removed: packages/workshop-frontend/src/components/BlueprintBindingCard.tsx:66

No matching single-line literal structure (including unsupported templates).

<pre>            aria-label={`Name for ${bindingName}`}</pre>

### added: packages/workshop-frontend/src/components/BlueprintBindingCard.tsx:66

No matching single-line literal structure (including unsupported templates).

<pre>            aria-label={`${bindingName}の名前`}</pre>

### removed: packages/workshop-frontend/src/components/BlueprintBindingCard.tsx:81

No matching single-line literal structure (including unsupported templates).

<pre>          aria-label={`Help text for ${displayTitle}`}</pre>

### added: packages/workshop-frontend/src/components/BlueprintBindingCard.tsx:81

No matching single-line literal structure (including unsupported templates).

<pre>          aria-label={`${displayTitle}の説明`}</pre>

### removed: packages/workshop-frontend/src/components/BlueprintCard.tsx:132

No matching single-line literal structure (including unsupported templates).

<pre>        aria-label={`Open blueprint ${metadata.title}`}</pre>

### added: packages/workshop-frontend/src/components/BlueprintCard.tsx:132

No matching single-line literal structure (including unsupported templates).

<pre>        aria-label={`ブループリント「${metadata.title}」を開く`}</pre>

### removed: packages/workshop-frontend/src/components/GadgetList.tsx:412

No matching single-line literal structure (including unsupported templates).

<pre>            ? `Remove "${deleteTarget?.title || 'Untitled Workspace'}" from your list? You can still access it via its link.`</pre>

### added: packages/workshop-frontend/src/components/GadgetList.tsx:412

No matching single-line literal structure (including unsupported templates).

<pre>            ? `Remove "${deleteTarget?.title || '無題のワークスペース'}" from your list? You can still access it via its link.`</pre>

### removed: packages/workshop-frontend/src/components/GadgetList.tsx:413

No matching single-line literal structure (including unsupported templates).

<pre>            : `Delete "${deleteTarget?.title || 'Untitled Workspace'}"? This cannot be undone.`</pre>

### added: packages/workshop-frontend/src/components/GadgetList.tsx:413

No matching single-line literal structure (including unsupported templates).

<pre>            : `Delete "${deleteTarget?.title || '無題のワークスペース'}"? This cannot be undone.`</pre>

### removed: packages/workshop-frontend/src/components/GadgetList.tsx:496

No matching single-line literal structure (including unsupported templates).

<pre>        aria-label={`Open blueprint ${blueprint.metadata.title}`}</pre>

### added: packages/workshop-frontend/src/components/GadgetList.tsx:496

No matching single-line literal structure (including unsupported templates).

<pre>        aria-label={`ブループリント「${blueprint.metadata.title}」を開く`}</pre>

### removed: packages/workshop-frontend/src/components/WorkspaceOpenErrorPage.test.tsx:54

Surrounding code, whitespace, or literal kinds differ.

<pre>    expect(renderedContainer.querySelector('h1')?.textContent).toBe("You don't have access to this workspace")</pre>

### added: packages/workshop-frontend/src/components/WorkspaceOpenErrorPage.test.tsx:54

Surrounding code, whitespace, or literal kinds differ.

<pre>    expect(renderedContainer.querySelector('h1')?.textContent).toBe('このワークスペースへのアクセス権がありません')</pre>

### removed: packages/workshop-frontend/src/components/WorkspaceOpenErrorPage.test.tsx:78

Surrounding code, whitespace, or literal kinds differ.

<pre>    expect(renderedContainer.querySelector('h1')?.textContent).toBe("We couldn't load this workspace")</pre>

### added: packages/workshop-frontend/src/components/WorkspaceOpenErrorPage.test.tsx:78

Surrounding code, whitespace, or literal kinds differ.

<pre>    expect(renderedContainer.querySelector('h1')?.textContent).toBe('このワークスペースを読み込めませんでした')</pre>

### removed: packages/workshop-frontend/src/components/chat/DataTab.tsx:69

No matching single-line literal structure (including unsupported templates).

<pre>                  aria-label={`Select ${row.channel}`}</pre>

### added: packages/workshop-frontend/src/components/chat/DataTab.tsx:69

No matching single-line literal structure (including unsupported templates).

<pre>                  aria-label={`${row.channel}を選択`}</pre>

### removed: packages/workshop-frontend/src/gatekeeper-modal/AccountChooser.tsx:67

No matching single-line literal structure (including unsupported templates).

<pre>            : `Pick which ${vendorName} identity this ${resourceTitle ?? 'connection'} should use.`}</pre>

### added: packages/workshop-frontend/src/gatekeeper-modal/AccountChooser.tsx:67

No matching single-line literal structure (including unsupported templates).

<pre>            : `Pick which ${vendorName} identity this ${resourceTitle ?? '接続'} should use.`}</pre>

### removed: packages/workshop-frontend/src/gatekeeper-modal/AgentSpawnerConfigForm.tsx:138

No matching single-line literal structure (including unsupported templates).

<pre>                  aria-label={`Give spawned agents access to ${row.targetTitle}`}</pre>

### added: packages/workshop-frontend/src/gatekeeper-modal/AgentSpawnerConfigForm.tsx:138

No matching single-line literal structure (including unsupported templates).

<pre>                  aria-label={`生成したエージェントに${row.targetTitle}へのアクセスを許可`}</pre>

### removed: packages/workshop-frontend/src/gatekeeper-modal/AgentSpawnerConfigForm.tsx:143

No matching single-line literal structure (including unsupported templates).

<pre>                  aria-label={`Binding name for ${row.targetTitle}`}</pre>

### added: packages/workshop-frontend/src/gatekeeper-modal/AgentSpawnerConfigForm.tsx:143

No matching single-line literal structure (including unsupported templates).

<pre>                  aria-label={`${row.targetTitle}のバインディング名`}</pre>

### removed: packages/workshop-frontend/src/routes/context.tsx:72

No matching single-line literal structure (including unsupported templates).

<pre>        title={`Context &amp; Skills are coming soon to ${siteName}`}</pre>

### added: packages/workshop-frontend/src/routes/context.tsx:72

No matching single-line literal structure (including unsupported templates).

<pre>        title={`${siteName}で「コンテキストとスキル」を近日提供予定です`}</pre>

### removed: packages/workshop-frontend/src/routes/outputs.tsx:698

No matching single-line literal structure (including unsupported templates).

<pre>        title={`Remove “${removeOutput?.title || 'Untitled'}”?`}</pre>

### added: packages/workshop-frontend/src/routes/outputs.tsx:698

No matching single-line literal structure (including unsupported templates).

<pre>        title={`「${removeOutput?.title || '無題'}」を削除しますか？`}</pre>

### removed: packages/workshop-frontend/src/useAutoApproval.ts:117

No matching single-line literal structure (including unsupported templates).

<pre>        title: `Failed to ${enabled ? 'enable' : 'disable'} auto-approval`,</pre>

### added: packages/workshop-frontend/src/useAutoApproval.ts:117

No matching single-line literal structure (including unsupported templates).

<pre>        title: `Failed to ${enabled ? '有効にする' : '無効にする'} auto-approval`,</pre>

### removed: packages/workshop-frontend/src/useWorkspaceOpen.test.tsx:138

Surrounding code, whitespace, or literal kinds differ.

<pre>    expect(container.textContent).toContain("You don't have access to this workspace")</pre>

### added: packages/workshop-frontend/src/useWorkspaceOpen.test.tsx:138

Surrounding code, whitespace, or literal kinds differ.

<pre>    expect(container.textContent).toContain('このワークスペースへのアクセス権がありません')</pre>

### removed: packages/workshop-frontend/src/utils/formatTimestamp.ts:14

No matching single-line literal structure (including unsupported templates).

<pre>    fullTimestampFormatter = new Intl.DateTimeFormat(undefined, {</pre>

### added: packages/workshop-frontend/src/utils/formatTimestamp.ts:14

No matching single-line literal structure (including unsupported templates).

<pre>    fullTimestampFormatter = new Intl.DateTimeFormat("ja-JP", {</pre>
