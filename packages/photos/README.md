# Photos Worker

`@gadgets/photos` は、Cloudflare OS の写真管理（Photos）のバックエンドです。
設計は `plans/photos.md` にあります。

Hono の REST API を `/api/photos/v1/*` で提供し、router の `PHOTOS` バインディングから呼ばれます。
メタデータは D1（`PHOTOS_DB`）に置き、長時間の処理と状態は Durable Object の SQLite に置きます。

## 認証

利用できるのは Cloudflare OS の管理者だけです。
各リクエストの認証情報（`Authorization`、`cf-access-jwt-assertion`）と `Origin`、`X-Photos-Request` だけを `WORKSHOP_AUTH` 経由で workshop-backend の `/api/photos-auth` に転送し、管理者であれば編集者として記録する `actor` を受け取ります。
クライアントが送る値から利用者を決めることはありません。

## 設定

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `PHOTOS_DB` | D1 | メタデータ。`database_id` は書かず、初回の `wrangler deploy` で `photos` という名前のデータベースが自動作成されます |
| `PHOTOS_CREDENTIAL_KEY` | secret（必須） | 32 バイトを base64 にした鍵。外部ストレージの認証情報の暗号化に使います。未設定か不正な値なら全 API が 503 を返します。一度設定したら変更しないでください |
| `PHOTOS_DIRECT_SHARE` | secret（任意） | Cloudflare Access を使わない構成でだけ設定します。`scripts/deploy.sh` が Access の有無を見て設定、削除します |

`scripts/deploy.sh` は `PHOTOS_CREDENTIAL_KEY` が未設定なら初回だけ生成します。
手動で設定する場合は次のとおりです。

```sh
openssl rand -base64 32 | pnpm --filter @gadgets/photos exec wrangler secret put PHOTOS_CREDENTIAL_KEY
```

## スキーマ

D1 のスキーマは Worker 自身が適用します。
各 isolate は最初のリクエストで `SchemaMigratorDO` を呼び、未適用のマイグレーション（`workers/db/migrations/`）を一つずつ原子的に適用します。
適用済みのマイグレーションは編集せず、新しいファイルを追加して `workers/db/migrate.ts` の一覧に足してください。

## 開発

```sh
pnpm --filter @gadgets/photos test:run   # workerd 上のテスト
pnpm --filter @gadgets/photos types:generate
```
