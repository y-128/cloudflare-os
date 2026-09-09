# 迷惑メール判定と Discord 通知

受信メールは、既存の宣言的ルール、ヒューリスティック、DNSBL、ベイズ分類に、送信者リスト、認証結果、受信頻度、添付検査を加えて判定します。
保存先と判定理由は MailboxDO の SQLite に記録します。
新しい依存パッケージ、D1、別の Worker は追加していません。

## 送信者リストと認証結果

新しい送信者リストは `BufferedEmail.from` の SMTP エンベロープ送信者を照合します。
メールアドレスとドメインは大文字小文字を区別せず完全一致で比較します。
`example.com` は `notexample.com`、`example.com.evil.tld`、`sub.example.com` に一致しません。
アドレスの `+tag` は削除しません。

一致する allow があれば block より優先し、その後の点数計算と受信数更新を省略して inbox に保存します。
添付検査は保存するバイト列の安全処理なので、allow の場合も実施します。
新しい block は SMTP 拒否のための `{ accepted: false, reason }` を返します。
既存の ConfigDO リストと宣言的ルールは残し、旧 block は従来どおり spam 保存とします。
新しい allow 判定後も、既存の通常メール用フィルターによる移動やラベル付けは行います。

認証結果には MIME 本文から再構成したヘッダーではなく、`BufferedEmail.headers` の `Authentication-Results` を使います。
SPF、DKIM、DMARC の各 `fail` に 20 点を加えます。
不明な値、欠落、不正な構文は unknown として 0 点にします。
折り返し、大小文字、入れ子コメント、引用文字列に対応し、重複結果では fail を後続の pass で取り消しません。
各結果は判定履歴に残ります。
SMTP 送信者と MIME From のドメインが異なる場合は 15 点を加えます。
転送でも不一致が起こるため、この点数だけでは既定の spam 閾値に届きません。
空の SMTP 逆経路は不明として扱います。
認証結果の `pass` を送信者 allow の根拠には使いません。

## 設定と既定値

設定は既存の `mailbox_settings` に `spam_policy` として保存します。
未設定なら妥当な旧 `spam_threshold` を引き継ぎ、それ以外には次の既定値を使います。
更新には `/spam/config` を使用してください。

| 設定キー | 既定値 | 判断理由 |
| --- | --- | --- |
| `spam_threshold` | 50 点以上 | 既存の振り分け閾値を維持します。 |
| `reject_threshold` | 100 点以上 | 拒否は複数の強い兆候が重なった場合に限定します。 |
| `rate_window_ms` | 600000（10 分） | 会話の往復を許容しつつ、短時間の連続送信を検出します。 |
| `rate_address_limit` | 30 通 | 同じ送信者の 31 通目から spam にします。 |
| `rate_domain_limit` | 100 通 | 複数送信者を持つドメインを考慮し、101 通目から spam にします。 |
| `attachment_max_bytes` | 10485760（10 MiB） | 単体の大きな添付を制限します。 |
| `attachment_total_bytes` | 20971520（20 MiB） | 保存する添付全体を、受信 MIME 上限 25 MiB より小さくします。 |

点数は各段階を合計し、0〜100 に制限します。
拒否閾値は spam 閾値より大きい整数でなければなりません。
認証、既存ヒューリスティック、既存 DNSBL の 30 点、既存ベイズ分類の最大 ±40 点に、受信数超過の 50 点と添付除去の 20 点を加えます。
危険拡張子の既存ヒューリスティックは添付検査と別の段階として記録します。

受信数超過、添付除去、旧 block がある場合は、合計点にかかわらず復旧可能な spam 保存を優先します。
新しい allow は inbox 保存、新しい block は SMTP 拒否を優先します。
受信頻度だけで SMTP 拒否することはありません。

受信数はメールボックス単位で集計します。
現在のメールを含む `(現在時刻 - window, 現在時刻]` のイベントを数えるため、ちょうど左境界のイベントは期限切れです。
挿入とアドレス別、ドメイン別集計は同期トランザクションで実行します。
期間を後から延長した場合に備えて最大 24 時間分を保持し、次の受信時に古いイベントを削除します。
設定可能な期間も最大 24 時間です。
allow で短絡したメールと新しい block で拒否したメールは集計しません。

## 添付ファイルの除去

`dangerous_extensions` にはドット付きの拡張子配列を指定します。
既定値は次のとおりです。

```text
.exe .scr .com .pif .bat .cmd .js .jse .vbs .vbe .wsf .wsh .jar .msi .lnk .reg .hta .cpl
.ws .wsc .ps1 .psm1 .msp
```

後半の拡張子は既存のヒューリスティックで危険とされていたものです。
`invoice.pdf.exe` のような二重拡張子、大小文字、末尾の空白やドットも検査します。
サイズはデコード後のバイト数で判定し、単体上限と、残す添付の合計上限をともに適用します。
不適合な添付を除去しても、安全な兄弟添付は残します。

ZIP、PDF、PNG、JPEG、GIF、旧 Office の OLE、現行 Office の ZIP コンテナについて、宣言 MIME と先頭識別バイトの一致を調べます。
`application/octet-stream` は汎用バイナリなので MIME 不一致の対象外です。
Office はコンテナの識別までで、ZIP 内の構造やマクロ、暗号化ファイルの内容は解析しません。

除去したバイト列は R2 に保存せず、自動転送にも渡しません。
本文末尾の通知、メールの `removed_attachments` JSON、判定履歴に、ファイル名、サイズ、除去理由を残します。
HTML 本文の通知ではファイル名をエスケープします。
メッセージ、添付メタデータ、判定履歴は同じ SQLite トランザクションで保存します。
R2 と SQLite の間には分散トランザクションがないため、SQLite 保存失敗時に安全な添付の孤立オブジェクトが残る可能性は既存構造と同様です。

## MailboxDO のマイグレーション

| 番号と名前 | 変更内容 |
| --- | --- |
| `10_sender_rules_and_rate_events` | `sender_rules` と `inbound_rate_events`、照合用索引 |
| `11_classification_log` | メールの `envelope_sender` と `removed_attachments`、`classification_log` |
| `12_discord_notification_rules` | `discord_notification_rules` |

いずれも `workers/durableObject/migrations.ts` の SQLite マイグレーションです。
既存の追跡テーブル名 `d1_migrations` は互換性のため維持していますが、保存先は D1 ではありません。
Wrangler の DO クラス移行タグ `v1`〜`v4` は変更していません。

拒否されたメールにはメール本体の行を作らず、判定履歴だけを残します。
履歴には段階別の点数と理由、最終点数、判定時の設定、SMTP 送信者、MIME From、添付除去情報を保存します。
「迷惑メールではない」操作は、inbox への移動と allow 登録を同じトランザクションで行います。
元の判定は監査用に残し、`corrected_at` を記録します。
新規メールは SMTP 送信者を allow に登録し、移行前メールまたは SMTP 逆経路が空の場合は保存済み MIME From を使います。

## REST API

以下のパスには共通の `/api/inbox/v1/mailboxes/:mailboxId` を付けます。
既存の Access 認証とメールボックス存在確認を使用します。
旧 `/spam-rules` は既存の宣言的ルール用として維持します。

| メソッドとパス | 内容 |
| --- | --- |
| `GET /spam/rules` | 新しい送信者 allow/block の一覧 |
| `POST /spam/rules` | `{ type, scope, pattern, note }` で登録 |
| `PUT /spam/rules/:id` | 同じ形式で既存ルールを更新 |
| `DELETE /spam/rules/:id` | 削除 |
| `GET /spam/config` | 解決済み設定の取得 |
| `PUT /spam/config` | 設定キーの部分更新 |
| `GET /spam/log?limit=25&before=100` | 降順の履歴、`items` と `next_before` を返却 |
| `POST /emails/:id/not-spam` | inbox へ移動して送信者を allow に登録 |
| `GET /notifications/discord` | 通知ルールと `timezone` の取得 |
| `PUT /notifications/discord` | 通知ルールの保存 |
| `POST /notifications/discord/test` | 固定のテスト通知を送信 |

ルールは最大 1000 件、履歴は 1 ページ最大 100 件です。
同じ type、scope、pattern の登録は既存ルールを更新します。
通知ルールは次の形式です。

```json
{
  "address_id": "hello@example.com",
  "enabled": true,
  "exclude_spam": true,
  "quiet_hours_start": "22:00",
  "quiet_hours_end": "07:00",
  "mention": ""
}
```

`address_id` はパスの `mailboxId` と一致させます。
初期状態は無効、spam 除外あり、時間帯指定なし、メンションなしです。
メンションは空文字、単一のユーザーまたはロール、`@everyone`、`@here` のいずれかです。
本文や件名からメンションの許可を増やすことはありません。

## Discord の設定と再試行

ローカルの設定形式は `.dev.vars.sample` に記載しています。
`[ここにWebhook URLを入力]` は角括弧ごと実値に置き換えます。
実際の秘密値を sample に保存しないでください。
本番の設定コマンドは次のとおりです。

```sh
cd packages/inbox
PATH="/usr/local/bin:$PATH" pnpm exec wrangler secret put DISCORD_WEBHOOK_URL
```

`CFOS_PUBLIC_URL` には cfos 公開元の HTTPS URL を指定します。
ローカルでは `.dev.vars`、本番では `wrangler.jsonc` の vars に設定できます。
公開元にはパス、クエリ、フラグメントを含めません。
どちらの設定も使用時に検証し、値をログへ出さず、変数名と設定先を含む日本語エラーにします。
Webhook は `https://discord.com/api/webhooks/...` とバージョン付き API パスに限定し、リダイレクトを許可しません。

通知はメッセージ保存後に、Web Push と同じ通知層から `waitUntil` で実行します。
Embed に送信者、件名、200 Unicode コードポイントまでの本文、添付の有無、除去件数、メールリンクを含めます。
件名と送信者欄は Discord の制限内に収め、サロゲートペアを分割しません。
通知時間帯は **Asia/Tokyo（日本時間）** です。
開始は含み、終了は含みません。
日付をまたぐ指定に対応し、開始と終了が同じ場合は時間帯による抑止を無効にします。
抑止された通知は後から再送しません。
テスト送信だけは、enabled と通知抑止時間帯を無視します。

通常の送信は初回と最大 3 回の再試行を行い、待機時間を 1 秒、2 秒、4 秒と増やします。
HTTP 429 は `retry_after` または `Retry-After` の待機時間と指数バックオフの長い方を使います。
一時的な接続障害と 5xx は再試行し、429 以外の 4xx は打ち切ります。
1 回の通信は最大 5 秒、通知全体は 25 秒を上限とします。
429 の待機時間が残り予算を超える場合は、指定時間より早く再送せず打ち切ります。
メールは既に保存済みなので、通知の最終失敗で配送結果は変わりません。
再試行間の永続キューは追加していません。

リンクは現在 `/inbox?mailboxId=...&emailId=...` を生成します。
既存 frontend にはメール詳細画面がないため、URL の生成は検証していますが、画面での遷移は未検証です。
並行して実装する frontend 側で同じ形式を解釈するか、`messageLink()` のパスを確定した形式へ合わせる必要があります。

## 検証コマンド

Node v24 のある `/usr/local/bin` を優先します。
全体テストでは workerd のメモリ消費を抑えるため並列数を 4 に制限します。

```sh
PATH="/usr/local/bin:$PATH" pnpm build
PATH="/usr/local/bin:$PATH" VP_RUN_CONCURRENCY_LIMIT=4 pnpm test
PATH="/usr/local/bin:$PATH" pnpm lint:check
PATH="/usr/local/bin:$PATH" pnpm --filter @gadgets/inbox exec tsc --noEmit
PATH="/usr/local/bin:$PATH" pnpm --filter @gadgets/inbox test:run
```

テストは実際の workerd と SQLite 上で、認証結果、完全一致ルール、allow 短絡、受信数の時間境界、添付除去、閾値、保存のロールバック、通知失敗時のメール保持、REST、Discord の文字制限、通知時間帯、再試行を検証します。
実際の Discord への送信はモックに置き換えています。

## 変更したファイル

パスは `packages/inbox/` からの相対パスです。

| ファイル | 変更理由 |
| --- | --- |
| `workers/index.ts` | 既存受信処理への判定、添付除去、通知層の接続 |
| `workers/lib/spam.ts` | 既存スコアリングの認証解析と拡張子設定への対応 |
| `workers/lib/spam-policy.ts` | 設定、ルール、履歴の型、既定値、最終判定 |
| `workers/lib/spam-pipeline.ts` | 既存分類器を維持した段階別判定 |
| `workers/lib/authentication.ts` | 認証ヘッダーの解析と SMTP/From 比較 |
| `workers/lib/attachment-inspection.ts` | 添付の検査、除去、本文への通知 |
| `workers/lib/discord.ts` | Webhook 設定検証、Embed、時刻判定、再試行 |
| `workers/lib/notifications.ts` | Web Push と Discord の共通通知層 |
| `workers/durableObject/index.ts` | 保存 API、原子的なメール保存、RPC 検証 |
| `workers/durableObject/mail-safety.ts` | 新しい設定、ルール、受信数、判定履歴の SQL 操作 |
| `workers/durableObject/migrations.ts` | マイグレーション 10〜12 |
| `workers/db/schema.ts` | メールの SMTP 送信者と添付除去情報 |
| `workers/routes/mail-safety.ts` | ルール、設定、履歴、訂正、通知テストの REST |
| `workers/types.ts` | 任意の通知用環境変数の型 |
| `.dev.vars.sample` | Discord と公開 URL の取得方法と設定形式 |
| `__tests__/spam-safety.test.ts` | 各判定段階、SQLite、受信、REST の回帰検証 |
| `__tests__/discord.test.ts` | 文字境界、通知時間帯、再試行、保存後通知の検証 |
| `README.md` | この運用仕様への案内 |
| `MAIL_SAFETY.md` | 既定値、API、設定手順、制限の記録 |

## 参照した仕様

- [Cloudflare Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Discord Webhook Resource](https://docs.discord.com/developers/resources/webhook)
- [Discord Rate Limits](https://docs.discord.com/developers/topics/rate-limits)
- [Discord Embed Limits](https://docs.discord.com/developers/resources/message#embed-limits)
