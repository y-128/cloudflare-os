# Inbox Worker

`@gadgets/inbox`は、`inbox-exp/main`のWorker側コードを移植した、cloudflare-os デプロイに含まれる Cloudflare Worker です。
Hono REST、Durable Object SQLite、R2、Cloudflare Email Service、Agents SDKを使用します。
Workshop ルーターの `MAIL_INBOX` バインディングから API と受信メールを受け付けます。
cfos の `/inbox` は Workshop SPA が提供します。メール API のみを MAIL_INBOX に転送し、Discord の `mailboxId` / `emailId` クエリで指定メールを開きます。

## エンドポイント

| 用途 | パス・エントリーポイント |
| --- | --- |
| REST API | `/api/inbox/v1/*` |
| MCP | `/api/inbox/mcp` |
| Agent WebSocket | `/api/inbox/agents/<agent>/<instance>` |
| 受信 | 名前付き`email(message, env, ctx)`およびdefault exportの`email` |
| 内部受信 RPC | default export の `deliverEmail({ from, to, rawBytes, headers })` |
| Durable Objects | `MailboxDO`、`ConfigDO`、`EmailAgent`、`EmailMCP` |

受信にはEmail Routingの配送先アドレスを使用し、To/Cc/Bccヘッダーは表示用データとして保存します。
MIMEストリームは一度だけバッファー化します。
サイズ不正・許可外の宛先・存在しないメールボックスは`setReject`で拒否します。
保存に失敗した場合は例外を配送基盤に伝えます。
保存後の通知・自動草稿・任意のVectorize更新はバックグラウンド処理です。

## セットアップ

1. リポジトリルートで`pnpm install`を実行します。
2. `packages/inbox/wrangler.jsonc`の`vars.DOMAINS`に、所有する受信ドメインを設定します。
3. `EMAIL_ADDRESSES`を設定します。既定のJSON文字列`"[]"`は、DOMAINS内の作成済みメールボックスを許可します。JSON配列も読み取り時に受け付けます。
4. ローカル設定が必要な場合は`.dev.vars.sample`を参考に`.dev.vars`を作成し、置換欄を角括弧ごと置き換えます。実値のあるファイルはGit管理対象外です。
5. 本番のR2バケット`inbox`と、必要ならプレビューバケット`inbox-preview`を作成します。既存のバケットを使う場合はWrangler設定の名前を変更します。
6. 所有ドメインのEmail RoutingとEmail Sendingを有効化し、Email Routing の宛先を router Worker に設定します。直接この Worker へ配送する既存構成も利用できます。
7. cfos では `WORKSHOP_AUTH` を workshop-backend にバインドします（標準設定済み）。既存の cfos 認証と `ADMINS` を設定してください。メール専用の Access アプリや秘密鍵は不要です。
8. APIからメールボックスを作成してから受信します。動的な宛先登録は`/api/inbox/v1/admin/addresses`で管理できます。

`DOMAINS`、`EMAIL_ADDRESSES`の省略や不正な値は、変数名と修正先を含む日本語エラーになります。
空のDOMAINSで全ドメインを許可することはありません。
ConfigDOにアドレスが一件でも登録されている場合、その有効なアドレスだけを許可します。
すべて無効化された場合にも旧許可リストへ戻りません。

cfos 統合構成では、管理者が全メールボックスと管理 API を共有します。ブラウザは同一オリジンの REST リクエストに既存の `authToken` を Bearer ヘッダーとして付け、Access 構成では既存の Access Cookie により付加された JWT を検証します。`WORKSHOP_AUTH` は各リクエストを backend の `/api/inbox-auth` に照会し、既存の RPC 認証と管理者 capability を再利用します。非単純ヘッダーと Origin の検査でクロスサイトリクエストを拒否します。セッショントークンを URL に含めません。

`WORKSHOP_AUTH` を外した旧単独構成のみ、従来の `POLICY_AUD` / `TEAM_DOMAIN` 検証を維持します。その構成は Access ポリシーを通過した全利用者に共有メールへのアクセスを許可します。
このパッケージ単体ではメールボックスごとの利用者権限を追加していません。

```sh
# リポジトリルートから、独立したローカルWorkerを起動
pnpm --filter @gadgets/inbox dev

# 型定義の再生成（Wrangler設定変更後）
pnpm --filter @gadgets/inbox types:generate

# 型チェックを含む全体ビルド
pnpm build

# workerd上のInboxテスト
pnpm --filter @gadgets/inbox test:run

# リポジトリ全体のlint
pnpm lint:check

# デプロイ用バンドルの検証のみ
pnpm --filter @gadgets/inbox exec wrangler deploy --dry-run

# 運用設定後の単独デプロイ
pnpm --filter @gadgets/inbox deploy
```

`WORKSHOP_AUTH` がある標準構成ではローカル開発も cfos の管理者認証が必要です。旧単独構成でのみ `dev` の `INBOX_LOCAL_DEV:true` が Access 認証を省略します。
本番設定のビルド定数は`false`です。
`send_email`に`remote: true`は設定していません。
ローカルから実際のメールを送るには、運用者が別途明示的にリモート設定を選ぶ必要があります。
`INBOX_LOCAL_DEV`は`.dev.vars`の変数ではありません。

## 保存と補助機能

メールと設定はSQLite-backed Durable Objects、添付とメールボックス登録はR2に保存します。
`workers/durableObject/migrations.ts`の移行名・SQL・順序、Wranglerのv1〜v4移行タグは移植元を保持しています。
`d1_migrations`は互換性のためのSQLiteテーブル名であり、D1バインディングではありません。

通常検索はSQLiteを使用します。
意味検索を利用する場合だけ、1024次元の埋め込みに対応するVectorizeインデックスを作成し、`VECTORIZE`バインディングを追加してください。
未設定の意味検索は設定先を示すエラーを返し、通常受信・SQLite検索には影響しません。

VAPID鍵はConfigDOが生成・保存するため、環境変数の秘密鍵は不要です。
既定の通知連絡先は`mailto:postmaster@<DOMAINSの先頭>`です。
AIモデルはConfigDOの`ai_model`設定、メールボックス設定・別名・ルール・予約送信は元のAPIで管理します。

メールボックス削除APIは移植元と同じ登録解除です。
保存済みのDOデータや添付を消去する操作ではありません。
R2とDOは共通トランザクションを持たないため、途中の障害で孤立した添付が残る可能性があります。
予約送信や外部メール配送にexactly-once配信保証は追加していません。

Workshopの一括リリース対象からは`inbox`を明示的に除外しています。
本パッケージは単独デプロイし、Workshopの`/api/*`ルーティングとは別に入口を設定してください。

詳細は[移植レポート](PORT_REPORT.md)を参照してください。
API形状は[Cloudflare Email Serviceの公式Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)と既存catalogの型定義に合わせています。

## Phase 3 のリリース契約

release manifest v2 は inbox を常設の `kind: "inbox"` として含めます。
`deploy-inputs.json` で DOMAINS と Access 設定を宣言し、R2・4つの Durable Object・AI・メール送信バインディングを manifest に保持します。
OAuth の CLIENT_ID／CLIENT_SECRET は要求しません。

外部 deploy service 本体はこのリポジトリに含まれません。
v2 対応では、inbox を初回配備・更新の対象に含め、DOMAINS／POLICY_AUD／TEAM_DOMAIN を収集または既存設定から供給し、inbox を配備してから router の `$WORKER_NAME(inbox)` を解決してください。
新しい `durable_object_namespace`・`send_email` バインディングを保持し、同一 Worker の DO クラスに migrations v1〜v4 を適用する必要があります。
旧 v1 deploy service はバージョン不一致で拒否させ、inbox を省略した部分配備を避けてください。
この外部実装と実アカウントへの配備は、今回のローカル検証には含まれません。

プレビューは inbox 専用の R2 を確保し、既存の Access 設定を inbox の変数名へ対応付けます。
DOMAINS は未設定のままなので、受信試験にはプレビュー用ドメインの設定と Email Routing が別途必要です。

router は MIME を一度読み込み、inbox を先に呼び出してから、Gadget の有効な hook がある場合だけ gatekeeper-email に同じバイト列を渡します。
Gadget の障害や hook の解除は、inbox が受理したメールを拒否しません。
両方が受理できなかった場合にだけ `setReject` を呼びます。
Cloudflare の `setReject` は恒久的な SMTP 拒否であり、自動再送を保証しません。

検証は Node 24 を優先し、全体テストの同時実行数を制限します。

```sh
PATH="/usr/local/bin:$PATH" VP_RUN_CONCURRENCY_LIMIT=4 pnpm test
PATH="/usr/local/bin:$PATH" pnpm build
PATH="/usr/local/bin:$PATH" pnpm lint:check
PATH="/usr/local/bin:$PATH" node --test 'scripts/**/*.test.ts'
```

迷惑メール判定の既定値、SQLite マイグレーション 10〜12、追加 REST API、Discord 通知の設定方法は [迷惑メール判定と Discord 通知](MAIL_SAFETY.md) を参照してください。

## メール画面の開発と検証

ルートで `PATH="/usr/local/bin:$PATH" pnpm dev-server` と `PATH="/usr/local/bin:$PATH" pnpm dev-client` を起動し、cfos 管理者でログインして `/inbox` を開きます。Vite は `/api/inbox` を dev router へプロキシします。

`PATH="/usr/local/bin:$PATH" pnpm run-local` でも inbox Worker が同時に起動します。
両コマンドは既存の複数 Worker 起動処理で `packages/inbox/wrangler.dev.jsonc` を生成し、
dev router の `MAIL_INBOX` を inbox の設定にあるサービス名へ接続します。
`WORKSHOP_AUTH` による管理者認証は維持するため、未認証の API リクエストは 403 になります。

実ドメインも Cloudflare API トークンも、基本的なローカル起動には不要です。
未設定の `DOMAINS` はテスト用の `inbox.test`、`EMAIL_ADDRESSES` は JSON 文字列 `[]` を使います。
後者はそのドメイン内の作成済みメールボックスを許可し、メールボックス自体を自動作成する設定ではありません。
シェルの `DOMAINS` / `EMAIL_ADDRESSES` を優先し、次に既存の Wrangler vars、最後に上記の既定値を使います。
保護された `.dev.vars` を作成・変更する必要はありません。

生成した開発設定は `send_email` の `remote` を `false` に固定し、実際のメールを送信しません。
Workers AI は `--use-workers-ai-binding` を指定した場合だけ有効です。
Cloudflare API クライアントは対応する管理 API の呼び出し時だけ生成されるため、
トークン未設定でも起動とローカルデータの参照は可能です。
DNS・ドメイン登録・外部転送先の管理など実 API が必要な操作は、未設定項目を示す JSON エラーを返します。

- `PATH="/usr/local/bin:$PATH" pnpm build`
- `PATH="/usr/local/bin:$PATH" VP_RUN_CONCURRENCY_LIMIT=4 pnpm test`
- `PATH="/usr/local/bin:$PATH" pnpm lint:check`

メール本文は DOMPurify でサニタイズ後、権限を一切許可しない sandbox iframe に表示します。CSP は外部画像・スクリプト・フォーム送信を禁止します。テキスト表示にも切替できます。
下書きは添付も含めて自動保存します。更新は直列化し、新版の保存後に旧版を削除します。R2 と SQLite 間の分散トランザクションはないため、障害時に旧下書きや孤立した添付が残ることはありますが、保存前に旧本文を破棄しません。

## ドメインとアドレスの初期設定（Phase 6）

メール画面の「ドメインとアドレス」を開きます。メールボックスがまだなくても利用できます。
管理者認証・`X-Inbox-Request: 1`・同一Originの既存認証経路を使用します。

事前に `packages/inbox/.dev.vars.sample` の説明に従い、ローカルでは
`packages/inbox/.dev.vars` に `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、
`MAIL_ROUTING_WORKER` を設定してください。`[ここに…を入力]` は角括弧ごと置き換えます。
本番ではトークンをWorker secret、他の2項目をWorker変数に設定します。
`MAIL_ROUTING_WORKER` は**公開ルーター**のデプロイ名です。これにより受信がinboxとGadget hookへ振り分けられます。
既存の `EMAIL`（`send_email`）、`CONFIG`、`MAILBOX`、`BUCKET`、`WORKSHOP_AUTH` バインディングも必要です。

トークンには対象アカウントの `Email Sending: Edit`、`Email Routing Addresses: Edit` と、
対象ゾーンの `Zone: Read`、`Zone Settings: Edit`、`Email Routing Rules: Edit`、`DNS: Edit` を付けます。
既存 gatekeeper-cloudflare の OAuth スコープは `oauth.ts` の `BILLING_SCOPES` / `AUTH_SCOPES` と
`resources.ts` の `workers-observability.read` に限られ、メール・DNSの編集権限を持たないため再利用しません。
トークンはブラウザーへ返さず、ログにも記録しません。

1. 所有するCloudflareゾーンのドメインを登録します。送信の有効化によりSPF・DKIMが自動追加されます。
2. 「受信を有効化してDNSを自動追加」でRoutingのMX・SPFを追加・ロックします。
   既存SPFやDKIMと競合するレコードを勝手に上書きしません。移行元のメールサービスがある場合は先に確認してください。
   外部DNSのゾーンでは表示された名前・種別・値・MX優先度をコピーします。
   Cloudflareにゾーンが存在しないドメインは登録できません。外部DNSでのRouting対応可否はCloudflareの実際の応答に従います。
3. 公開DNSを照会し、各レコードの「確認済み／確認待ち／確認失敗」を表示します。
   通常5〜15分かかります。確認待ちは30秒間隔で照会し、失敗時は自動再試行を停止します。
4. DNS確認後にcatch-allを設定します。既存のcatch-allを公開ルーターへ置き換える操作です。
   個別のRoutingルールが優先されるため、既存ルールはCloudflare管理画面で確認してください。
5. アドレスと表示名を入力してメールボックスを作成します。同じアドレスで再試行できます。
   未登録宛先を1つのメールボックスへ集約する設定はドメインごとに1つです。
   作成済みアドレスは既存のConfigDOアドレス許可リストへ登録され、MailboxDOとR2の既存初期化経路を使います。
   有効化したドメインは永続設定から許可リストへ加わるため、`DOMAINS`を毎回編集する必要はありません。
6. DMARCは自動設定されません。推奨TXTは `_dmarc.<domain>` に
   `v=DMARC1; p=quarantine; rua=mailto:postmaster@<domain>` です。
   postmasterメールボックスを作成するか、`rua`をレポートを受け取れる宛先に変更してください。

「外部の転送先アドレス」ではアカウント全体の宛先と確認状態を表示します。
追加時にCloudflareが確認メールを送信します。リンクを開いた後、「確認状態を更新」で確認してください。
**未確認宛先への転送はエラーが出ず届かない場合があります。**
登録だけでは転送は有効になりません。ローカルメールボックス作成と外部転送先の確認は別の操作です。
送信上限は `GET /accounts/{account_id}/email/sending/limits` の現在値を表示します。
このAPIのフィールドを推測せず、そのまま表示します。既存cfosのメールボックス単位の送信制限も適用されます。

ドメイン・アドレスの永続テーブルは、**このデプロイ全体**のConfigDOに保存します。
`configMigrations` の新規タグ `13_mail_domains_and_addresses` で作成します。
既存MailboxDOのマイグレーション10〜12は変更していません。

## 外部メールクライアントのSMTP設定

cfos自体は `send_email` Workersバインディングで送信します。**cfosの利用にSMTP設定は不要です。**
以下はThunderbirdなどの外部クライアント向けの送信専用設定です。IMAP・POP3受信サービスは提供しません。

| 項目 | 設定 |
| --- | --- |
| ホスト | `smtp.mx.cloudflare.net` |
| ポート | `465` |
| 接続の保護 | 接続開始時からTLS（SMTPS / SSL/TLS）。587のSTARTTLSではありません |
| 認証方式 | 通常のパスワード認証 |
| ユーザー名 | 文字列 `api_token` |
| パスワード | `Email Sending: Edit`権限を持つCloudflare APIトークン |
| 宛先数 | 1セッションあたり50宛先 |
| メッセージサイズ | 5 MiB |
| 認証タイムアウト | 30秒 |
| データタイムアウト | 300秒 |

1. [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)を開きます。
2. Create Token → Create Custom Tokenを選びます。
3. Permissionsに Account → Email Sending → Editを設定します。
4. Account Resourcesを送信ドメインのアカウントだけに限定し、有効期限を設定します。
5. 確認後に作成し、一度だけ表示されるトークンを安全に保管します。
6. メールクライアントに上表を設定し、パスワード欄へトークンを入力します。
   差出人は確認済み送信ドメインのアドレスにします。cfos画面にはトークンを貼り付けません。

## Phase 6 の検証

リポジトリルートで以下を実行します。Node v24のPATHとworkerd並列数を維持してください。

```sh
PATH="/usr/local/bin:$PATH" pnpm --filter @gadgets/inbox test:run
PATH="/usr/local/bin:$PATH" pnpm --filter @gadgets/workshop-frontend test:run
PATH="/usr/local/bin:$PATH" pnpm build
PATH="/usr/local/bin:$PATH" VP_RUN_CONCURRENCY_LIMIT=4 pnpm test
PATH="/usr/local/bin:$PATH" pnpm lint:check
```

ローカル起動は `PATH="/usr/local/bin:$PATH" pnpm dev-server` を使用します。
本番のドメイン有効化・DNS変更・確認メール・SMTP接続は実アカウントで別途確認してください。
API境界はモック応答、永続化はworkerdの実SQLite、UIはi18nを有効にしたDOMテストで検証します。

仕様: [Email Sending](https://developers.cloudflare.com/api/resources/email_sending/)、
[送信ドメイン作成](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/methods/create/)、
[Routing有効化](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/)。
送信ドメイン管理はアカウントではなくゾーン単位の `/zones/{zone_id}/email/sending/subdomains` を使用します。
