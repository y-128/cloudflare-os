# cfos デプロイ手順書

Cloudflare に cfos をデプロイし、実ドメインでメールを送受信できる状態にするまでの手順です。

この手順は上から順に実行してください。途中で失敗した場合、後続の手順が前提を満たさなくなります。

---

## 0. 前提の確認

### 必要なもの

| 項目 | 説明 |
|---|---|
| Cloudflare アカウント | **Workers Paid プラン($5/月)が必須**。Email Sending と Durable Objects が無料プランでは使えません |
| ドメイン | Cloudflare にゾーンとして登録済みのもの。メールに使います |
| Cloudflare API トークン | 権限は後述。ダッシュボードで発行します |
| Discord サーバー | Incoming Webhook を作れる権限があること |
| 検証用の外部メールアドレス | Gmail など、実在して自分が受信できるもの |

### ローカル環境

このマシンには Node が2つ入っており、**古いほうが PATH で優先されています**。シェルごとに1回、以下を実行してください。

```bash
cd /Users/y-128/Project/cfos
export PATH="/usr/local/bin:$PATH"   # Node 24 を優先
node -v                              # v24 系と出ることを確認
```

`~/.local/bin/node` は v22 で `URLPattern` がグローバルに無いため、`packages/gatekeeper-google` のテストが `ReferenceError` で誤って失敗します。CI は `.github/workflows/ci.yml` の `NODE_VERSION` で 24 系に固定されています。

テスト実行時はさらに同時実行数を絞ってください。

```bash
VP_RUN_CONCURRENCY_LIMIT=4 pnpm test
```

`scripts/vp/concurrency.ts` は 16 GiB のこのマシンで並列度を8と算出しますが、workerd を使うテスト群が重く、メモリ不足で強制終了(exit 137)します。CI と同じ4に固定します。

恒久化する場合はリポジトリ直下の `.env`(gitignore 済み)に書いてください。`scripts/vp/concurrency.ts` がここを読みます。

```bash
echo 'VP_RUN_CONCURRENCY_LIMIT=4' >> .env
```

アプリ側の環境変数(Cloudflare API トークン、Discord Webhook など)は `.env.sample` に一覧があります。手順6で Worker の secret として設定します。

---

## 一括実行(推奨)

手順3〜6(R2バケット作成を除くデプロイと secret 設定)は1コマンドで済みます。個別に実行したい場合は、この節を飛ばして手順1から順に進めてください。

```bash
cd /Users/y-128/Project/cfos
cp deploy.config.sample.json deploy.config.json
# deploy.config.json を編集して値を入れる(取得方法は .env.sample と手順1〜2を参照)

./scripts/deploy.sh --dry-run   # 何をするか確認する
./scripts/deploy.sh             # 実行する
```

スクリプトが行うこと。

1. Node 24 と pnpm の確認
2. `pnpm build`
3. **正しい順序**で5つの Worker をデプロイ(router は他を参照するので最後)
4. デプロイ結果から**公開 URL を検出**
5. 公開 URL のリダイレクト先から **Cloudflare Access のチーム URL と Application Audience を検出**
6. secret を Worker ごとに振り分けて一括設定

Access の2値は自動検出されるので、`deploy.config.json` に書く必要はありません。Access を使っていない場合は検出されず、その分の secret は設定されません。

`CFOS_PUBLIC_URL` と `MAIL_ROUTING_WORKER` も自動で決まります。明示したい場合だけ書いてください。

| オプション | 動作 |
|---|---|
| `--dry-run` | アップロードも secret 設定も行わず、何をするかだけ表示 |
| `--secrets` | デプロイを飛ばし、secret の設定だけ行う |
| `--yes` | 確認プロンプトを省略 |

値は表示もログ出力もされず、コマンドライン引数にも置かれません(`wrangler secret bulk` へ標準入力で渡します)。`deploy.config.json` は `.gitignore` 済みです。

R2 バケットの作成(手順3)は初回のみ必要で、スクリプトには含めていません。

---

## 1. API トークンの発行

Cloudflare ダッシュボード > 右上のアカウントアイコン > **My Profile** > **API Tokens** > **Create Token** > **Create Custom Token**

必要な権限:

| 種別 | 対象 | 権限 | 用途 |
|---|---|---|---|
| Account | **Email Sending** | **Edit** | 送信ドメインのオンボードと送信枠の取得 |
| Account | Email Routing Addresses | Edit | 転送先アドレスの一覧と追加 |
| Account | Workers Scripts | Edit | デプロイ |
| Account | Workers R2 Storage | Edit | 添付ファイル |
| Account | Workers AI | Read | 下書き生成・スパム判定 |
| Zone | **Zone Settings** | **Edit** | Email Routing の状態取得と有効化 |
| Zone | Email Routing Rules | Edit | catch-all ルールの作成 |
| Zone | DNS | Edit | SPF / DKIM / MX の追加 |
| Zone | Zone | Read | ゾーンの検索 |

**Zone Settings を忘れないでください。** 名前から想像しにくいのですが、Email Routing の操作は `Email Routing Rules` ではなく **Zone Settings** を要求します。

| 操作 | エンドポイント | 必要な権限 |
|---|---|---|
| 状態の取得 | `GET /zones/{id}/email/routing` | [Zone Settings Read または Write](https://developers.cloudflare.com/api/resources/email_routing/methods/get/) |
| 有効化 | `POST /zones/{id}/email/routing/enable` | [Zone Settings **Write**](https://developers.cloudflare.com/api/resources/email_routing/methods/enable/) |

有効化まで行うので **Edit(Write)** を選んでください。Read だけだとドメイン一覧は見えても有効化が 403 になります。

**Email Sending はアカウントスコープにしかありません。** ゾーンスコープの一覧を探しても見つかりません。これが無いと `Cloudflare API (HTTP 403): 10000: Authentication error` になります。

> `/zones/{zone_id}/email/sending/subdomains`(送信サブドメインの登録)に必要な権限は、
> **Cloudflare の公式ドキュメントに明記されていません。** アカウントスコープの Email Sending: Edit
> で通ると考えられますが、確証はありません。403 が続く場合は、まず Email Sending: Edit が
> 付いているかを確認し、それでも解決しなければ一時的に広い権限のトークンで切り分けてください。

Zone Resources は対象ドメインを指定してください。**指定しなかったゾーンは検索できず**、ドメインのオンボードに失敗します。

> **受信ドメインは Cloudflare の「ゾーン」である必要があります。**
>
> Email Routing はゾーン単位の機能です。`y.example.com` のようなサブドメインは、それ自体がゾーンとして登録されていない限り指定できません。ゾーンが `example.com` なら、受信ドメインにも `example.com` を指定します。
>
> 現在どれがゾーンかは次で確認できます。
>
> ```bash
> pnpm --filter @gadgets/inbox exec wrangler zones list 2>/dev/null || \
>   echo "ダッシュボードの Websites 一覧で確認してください"
> ```

発行されたトークンは**この画面でしか表示されません**。すぐに控えてください。

同じ画面の右上に **Account ID** が表示されています。これも控えてください。

---

## 2. Discord Webhook の作成

Discord の対象サーバー > **サーバー設定** > **連携サービス** > **ウェブフック** > **新しいウェブフック**

投稿先チャンネルを選び、**ウェブフックURLをコピー** します。

形式: `https://discord.com/api/webhooks/<id>/<token>`

---

## 3. R2 バケットの作成

```bash
cd /Users/y-128/Project/cfos
export PATH="/usr/local/bin:$PATH"

pnpm exec wrangler r2 bucket create inbox
pnpm exec wrangler r2 bucket create photos
```

`inbox` は添付ファイルの保存先です。バケット名は `packages/inbox/wrangler.jsonc` の `bucket_name` と一致している必要があります。
`photos` は写真（Photos）の保存先で、`packages/photos/wrangler.jsonc` の `bucket_name` と一致している必要があります。
Photos のメタデータ用 D1 データベース `photos` は、初回のデプロイで自動作成されるので手動の作成は不要です。

---

## 4. ビルド

```bash
pnpm install
pnpm build
```

`exit 0` になることを確認してください。

---

## 5. Worker のデプロイ

**順序が重要です。** router は他の Worker をサービスバインディングで参照するため、参照先を先にデプロイします。

```bash
# 5-1. バックエンド
pnpm --filter @gadgets/workshop-backend exec wrangler deploy

# 5-2. メール受信・保存
pnpm --filter @gadgets/inbox exec wrangler deploy

# 5-3. メール用 gatekeeper(Gadget にメールを渡す)
pnpm --filter @gadgets/email-gatekeeper exec wrangler deploy

# 5-4. 公開オリジン。上3つを参照する
pnpm --filter @gadgets/router exec wrangler deploy
```

> **リポジトリ直下で `wrangler deploy` を実行しないでください。**
>
> 直下の `wrangler.jsonc` は **`dev-router`** という名前のローカル開発専用の設定です。直下で引数なしの `wrangler deploy` を叩くと、これが本番にデプロイされます。
>
> **`--config packages/…/wrangler.jsonc` も使えません。** 各 wrangler.jsonc は `pnpm run build:worker` のようなカスタムビルドを持ち、そのスクリプトはパッケージ内の package.json にしかありません。直下から実行すると root の package.json を見にいき、次のエラーで失敗します。
>
> ```
> [ERR_PNPM_NO_SCRIPT] Missing script: build:worker
> ```
>
> `--filter` はパッケージ内で実行するので、どちらの問題も起きません。

パッケージ名がディレクトリ名と一致しないものがあります。`gatekeeper-email` の名前は **`@gadgets/email-gatekeeper`** です(前後が逆)。

実行前に `--dry-run` を付けると、アップロードせずにビルドとバインディングの確認だけができます。

```bash
pnpm --filter @gadgets/router exec wrangler deploy --dry-run
```

他の gatekeeper(GitHub、Google、Slack 等)は必要になった時点で個別にデプロイしてください。router は `GATEKEEPER_*` のバインディングを走査する設計なので、後から追加できます。

デプロイ後、`router` に独自ドメインを割り当てます。ダッシュボードの **Workers & Pages** > `router` > **Settings** > **Domains & Routes** から追加してください。ここで割り当てた URL が cfos の公開 URL になります。

---

## 6. secret の設定

`inbox` Worker に設定します。1つずつ実行し、プロンプトに値を貼り付けてください。

値は `.env.sample` に一覧があります。取得方法もそこに書いてあります。

```bash
cd /Users/y-128/Project/cfos
export PATH="/usr/local/bin:$PATH"

# 手順1のトークン
pnpm --filter @gadgets/inbox exec wrangler secret put CLOUDFLARE_API_TOKEN

# 手順1のアカウントID
pnpm --filter @gadgets/inbox exec wrangler secret put CLOUDFLARE_ACCOUNT_ID

# 手順2のWebhook URL
pnpm --filter @gadgets/inbox exec wrangler secret put DISCORD_WEBHOOK_URL

# 手順5で割り当てた公開URL(末尾スラッシュなし)
pnpm --filter @gadgets/inbox exec wrangler secret put CFOS_PUBLIC_URL

# 値は router
pnpm --filter @gadgets/inbox exec wrangler secret put MAIL_ROUTING_WORKER
```

1つ実行するごとに `Enter a secret value:` と聞かれるので、値を貼り付けて Enter を押します。入力は伏せ字になります。

> コマンドを短くするために `INBOX="--filter …"` のような変数に入れてはいけません。**zsh は変数展開時に単語分割をしない**ため、文字列全体が1つの引数として渡され `Unknown option` になります。bash では動きますが、macOS の既定シェルは zsh です。

`CFOS_PUBLIC_URL` は Discord 通知のディープリンク生成に使われます。ここが間違っていると、通知のリンクを踏んでも該当メールに飛べません。

`MAIL_ROUTING_WORKER` は Email Routing の catch-all ルールの転送先 Worker 名です。手順5-4 でデプロイした router の名前、つまり `router` を入れます。

### 管理者の指定(必須。忘れるとメール画面が 403 になります)

**メール API は管理者権限を要求します。** `wrangler deploy` で手動デプロイした場合、管理者は誰も設定されていないため、そのままではメール画面が `403 Forbidden` になります。

公式のワンクリックデプロイならデプロイサービスが自動で入れますが、手動デプロイでは自分で設定する必要があります。ローカル開発では `scripts/run-dev-server.ts` が `["admin"]` を入れるので、この問題は起きません。

自分のユーザー名を cfos の画面(右下のユーザーメニュー、または `/profile`)で確認してから設定します。

```bash
pnpm --filter @gadgets/workshop-backend exec wrangler secret put ADMINS
```

プロンプトには**JSON 配列**を入力します。角括弧とダブルクォートを含めてください。

```
["あなたのユーザー名"]
```

複数人を管理者にする場合は `["alice","bob"]` のように並べます。設定後はブラウザを再読み込みするだけで反映されます。再デプロイは不要です。

### Cloudflare Access の設定(独自ドメインで運用する場合)

`*.workers.dev` のまま使う場合、この節は不要です。Access を前段に置けないため、cfos 自身のログイン(パスワード認証または gatekeeper 経由)で保護されます。

独自ドメインに Access を掛ける場合は、`router` のドメインに対して Access アプリケーションを作成し、発行される値を設定します。

> **変数名が Worker ごとに違います。** 同じ値を別の名前で設定する必要があります。
>
> | Worker | AUD タグ | チームURL |
> |---|---|---|
> | inbox | `POLICY_AUD` | `TEAM_DOMAIN` |
> | workshop-backend | `CF_ACCESS_AUD` | `CF_ACCESS_ISS` |

```bash
# inbox
pnpm --filter @gadgets/inbox exec wrangler secret put POLICY_AUD
pnpm --filter @gadgets/inbox exec wrangler secret put TEAM_DOMAIN

# workshop-backend (名前が違うことに注意)
pnpm --filter @gadgets/workshop-backend exec wrangler secret put CF_ACCESS_AUD
pnpm --filter @gadgets/workshop-backend exec wrangler secret put CF_ACCESS_ISS
```

`TEAM_DOMAIN` は Access のベース URL でも、`/cdn-cgi/access/certs` を含むフル URL でも受け付けます。`CF_ACCESS_ISS` はベース URL を入れてください。

`CF_ACCESS_AUD` を設定すると、workshop-backend は Access による認証に切り替わります。設定しなければ cfos 自身のログインを使います。

---

## 7. ドメインのオンボード

ここからはブラウザで行います。

1. 手順5で割り当てた公開 URL を開く
2. Access のログインを通る
3. サイドバーの **メール** を開く
4. 左側の **ドメイン設定** を開く
5. ドメイン名を入力して開始

画面が以下を順に行います。

- Email Sending の有効化
- Email Routing の有効化
- 必要な DNS レコードの表示(SPF の TXT、DKIM、受信用の MX)
- Cloudflare 管理下のゾーンなら自動追加、外部 DNS なら手動コピー用に表示
- 検証状態のポーリング表示
- catch-all ルーティングルールの作成(転送先は router)

DNS の伝播は通常 5〜15 分です。検証が **verified** になるまで待ってください。

### DMARC の追加(推奨)

DMARC は自動設定されません。画面に推奨レコードが表示されるので、DNS に追加してください。

```
名前: _dmarc.yourdomain.com
種別: TXT
値:   v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@yourdomain.com
```

### CLI で確認する場合

```bash
pnpm exec wrangler email sending list
pnpm exec wrangler email sending dns get yourdomain.com
```

---

## 8. 転送先アドレスの検証

メールを外部アドレスへ転送する場合、**転送先は事前に検証が必要です。未検証のアドレスへの転送は無言で失敗します。**

ドメイン設定画面の **転送先アドレス** から追加してください。確認メールが届くので、リンクを踏んで検証を完了させます。

CLI の場合:

```bash
pnpm exec wrangler email routing addresses create you@gmail.com
```

---

## 9. メールボックスの作成

ドメイン設定画面の **アドレス** から、使いたいアドレスのローカルパート(`@` の前)を入力して作成します。作成と同時に対応する Durable Object が初期化されます。

---

## 10. E2E 検証チェックリスト

上から順に確認してください。`wrangler tail` でログを見ながら行うと原因が追いやすくなります。

```bash
pnpm exec wrangler tail inbox
```

ログは `[処理名]` の接頭辞が付いているので `grep` で絞り込めます。

### 10-1. 受信

- [ ] 外部アカウント(Gmail 等)から cfos のアドレス宛にメールを送る
- [ ] cfos の `/inbox` に数秒以内に表示される
- [ ] Discord に Embed 通知が届く
- [ ] 通知のリンクを踏むと該当メールが開く(`CFOS_PUBLIC_URL` が正しいかの確認)

### 10-2. 添付

- [ ] 添付付きメールを送り、添付がダウンロードできる
- [ ] `.exe` 添付を送ると、添付が除去された状態でメール本体は届き、何を除去したか本文に記録されている

### 10-3. 送信とスレッド

- [ ] cfos から新規メールを送信でき、Gmail 側に届く
- [ ] cfos から返信すると、Gmail 側で**同一スレッドにぶら下がる**

スレッドが分かれてしまう場合は `In-Reply-To` と `References` ヘッダの生成が疑わしいので、`packages/inbox/workers/lib/email-helpers.ts` の `buildThreadingHeaders` 付近を確認してください。

### 10-4. スパム判定

- [ ] SPF が fail するメールが `spam` に振り分けられる
- [ ] 拒否リストに追加したアドレスからのメールが SMTP レベルで拒否される
- [ ] 許可リストに追加したアドレスは、スコアが高くても `inbox` に入る
- [ ] 短時間に大量送信するとレート制限が効き `spam` に入る(既定: 10分間でアドレスあたり30通)
- [ ] 「スパムでない」操作でメールが `inbox` に移り、送信元が許可リストに昇格する

### 10-5. SMTP(外部クライアント)

Thunderbird などに以下を設定します。

| 項目 | 値 |
|---|---|
| サーバー | `smtp.mx.cloudflare.net` |
| ポート | `465` |
| 接続の保護 | **SSL/TLS**(STARTTLS ではありません) |
| 認証方式 | 通常のパスワード認証 |
| ユーザー名 | `api_token`(この文字列そのもの) |
| パスワード | `Email Sending: Edit` 権限の API トークン |

- [ ] cfos のドメインのアドレスから送信できる

制限: 1セッションあたり宛先50件、メッセージ 5 MiB、認証タイムアウト30秒、データタイムアウト300秒。

なお **cfos 自体は SMTP を使いません**。Workers の `send_email` バインディングで送信します。SMTP は外部メールクライアント用の口です。

### 10-6. リンク集

- [ ] `/links` でカテゴリとリンクを追加・編集・削除できる
- [ ] ドラッグで並べ替えた順序が保存される
- [ ] 検索がタイトル・URL・タグ・メモに効く

### 10-7. 日本語表示

- [ ] 全画面が日本語で表示される
- [ ] 設定から英語に切り替えられ、切り替え後も表示が追従する
- [ ] `[missing: ...]` という表示が出ない

---

## 11. トラブルシューティング

### メールが届かない

1. `wrangler email routing rules list` で catch-all ルールの転送先が `router` になっているか確認
2. `wrangler tail router` でルーターにイベントが届いているか確認
3. MX レコードが Cloudflare のものになっているか確認

router は inbox と gatekeeper-email の**両方が受理しなかったときだけ** SMTP を拒否します。片方が受理していればメールは保存されています。

### 送信が `550 5.7.1 Sender denied` で失敗する

送信元ドメインが Email Sending にオンボードされていません。手順7をやり直してください。

### SMTP 認証が `535 5.7.8` で失敗する

API トークンの権限に `Email Sending: Edit` が無いか、トークンが失効しています。手順1で作り直してください。

### Discord 通知が来ない

1. ドメイン設定の通知画面から**テスト送信**を実行する
2. 静穏時間帯(quiet hours)に入っていないか確認する。タイムゾーンは `Asia/Tokyo` で、開始時刻は含み終了時刻は含みません
3. `exclude_spam` が有効で、対象メールが `spam` 判定になっていないか確認する

Discord への送信が失敗してもメールの保存は必ず行われます。通知だけが落ちている状態です。

### `/api/inbox/*` が 404 を返す

router に `MAIL_INBOX` のサービスバインディングが無い状態です。手順5-2(inbox のデプロイ)が済んでいるか、その後に手順5-4(router のデプロイ)をやり直したかを確認してください。**inbox を先にデプロイしてから router をデプロイし直す**必要があります。

### `/api/inbox/*` が 403 を返す

正常な認証拒否です。ブラウザから Access を通してアクセスしてください。`curl` で直接叩くと 403 になります(`X-Inbox-Request: 1` ヘッダと Origin 一致を要求する CSRF 対策のため)。

---

## 12. ローカルでの動作確認

デプロイ前にローカルで確認する場合:

```bash
cd /Users/y-128/Project/cfos
export PATH="/usr/local/bin:$PATH"
pnpm run-local
```

http://localhost:8787 が開きます。開発用の既定値として `DOMAINS=inbox.test` が入っているので、実ドメインなしで起動します。

ローカルでは実際のメール送受信はできません。UI、リンク集、日本語化の確認に使ってください。

実際にメールを送って試したい場合は `packages/inbox/wrangler.jsonc` の `send_email` に `"remote": true` を追加します。ただし**実際にメールが送信されます**。宛先は自分が管理するアドレスだけにし、**デプロイ前に必ず外してください**。

---

## 付録: 変数一覧

### inbox Worker

| 変数 | 種別 | 用途 |
|---|---|---|
| `DOMAINS` | vars | 受信対象ドメイン |
| `EMAIL_ADDRESSES` | vars | 受信アドレスの JSON 配列 |
| `CLOUDFLARE_API_TOKEN` | secret | Email Service / DNS 操作 |
| `CLOUDFLARE_ACCOUNT_ID` | secret | 同上 |
| `DISCORD_WEBHOOK_URL` | secret | 新着通知 |
| `CFOS_PUBLIC_URL` | secret | 通知のディープリンク生成 |
| `MAIL_ROUTING_WORKER` | secret | catch-all の転送先 Worker 名 |
| `POLICY_AUD` | secret | Cloudflare Access |
| `TEAM_DOMAIN` | secret | Cloudflare Access |

### バインディング

| バインディング | 種別 | 対象 |
|---|---|---|
| `EMAIL` | send_email | Cloudflare Email Sending |
| `BUCKET` | R2 | `inbox` バケット(添付) |
| `AI` | Workers AI | 下書き生成・スパム判定 |
| `WORKSHOP_AUTH` | Service | `workshop-backend`(認証) |
| `MAILBOX` / `CONFIG` / `EMAIL_AGENT` / `EMAIL_MCP` | Durable Object | メール本体・設定・エージェント・MCP |

### router Worker

| バインディング | 対象 |
|---|---|
| `WORKSHOP_BACKEND` | `workshop-backend` |
| `MAIL_INBOX` | `inbox` |
| `GATEKEEPER_EMAIL` | `gatekeeper-email` |
| `ASSETS` | フロントエンドの静的アセット |
