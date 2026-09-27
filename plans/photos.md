# 計画: Cloudflare OS Photos

## 目的

Cloudflare OS に、NAS と複数の Cloudflare アカウントの R2 を横断して写真を管理する **Photos** を追加する。
Photos は画像編集ソフトではなく、整理、検索、保管、バックアップ、公開、配布を受け持つ。
既存のフィルム風ギャラリーは別アカウントの別サービスのまま維持し、Photos は公開用の **Publication Manifest** を書き出すだけにとどめる。

この文書は、ユーザー作成の構想（全体アーキテクチャ、画面、ER 設計、フェーズ分け）をコードレベルに落としたものである。
対象は、ディレクトリ構成、D1 スキーマ、Durable Object のスキーマ、TypeScript の型、API エンドポイント、既存コードとの接点である。

## 確定事項

- **配置**：Inbox と同じく独立した Worker（`packages/photos`）にする。Hono の REST API を持ち、認証は `WORKSHOP_AUTH` サービスバインディングで workshop-backend に委譲し、router が `/api/photos/*` を転送する。
- **ライブラリはデプロイ全体で一つ**：Inbox と同じく、管理者全員が一つのライブラリを共有し、管理者以外は Photos を使えない。テーブルに所有者の列は持たず、編集者の記録として `created_by` と `updated_by` だけを持つ。
- **永続メタデータは D1**：Photo、Asset、EXIF、Tag、Album、Photographer、StorageConnection、Publication を一つの D1 データベースに置く。写真本体や派生画像は入れない。
- **処理と状態管理は Durable Object の SQLite**：Import ジョブ、Upload セッション、Publication ジョブを `PhotoJobsDO` に、NAS Agent との接続と死活を `NasAgentDO` に置く。DO は進行中の状態だけを持ち、確定した結果は D1 に書き込む。
- **Photo と File を分ける**：一枚の写真（Photo）に、原本、原本の複製、プレビュー、サムネイルの各ファイル（PhotoAsset）を関連付ける。RAW と JPEG の組も、一つの Photo に原本 Asset が二つある状態として表す。
- **ストレージの差は Storage Provider に閉じ込める**：初期実装は `r2-binding`、`r2-s3`、`nas` の三種類とする。
- **R2 の大きなファイルは Worker を経由させない**：署名付き URL を基本とする。例外は後述の「同一アカウント R2 の署名付き URL」で扱う。
- **NAS の原本は Worker が中継して配る**：ブラウザは NAS を直接見ない。Worker が Tunnel 越しに Agent から受け取り、そのままブラウザへ流す。
- **NAS Agent への指示は WebSocket、データは Tunnel**：Agent が `NasAgentDO` へ WebSocket を張り続け、指示と結果はそこを通す。ファイルの読み出しは Worker から Tunnel 越しの HTTP で行う。
- **NAS の HDD スリープを妨げない**：Agent は待機中にディスクへ触れない（要件は「NAS Storage Agent」の節）。
- **共有は二経路**：限定公開リンクは Publication Target（一時共有ギャラリー）として外部へ書き出すのを基本とし、Cloudflare Access を使わない構成に限り、Photos Worker が直接配る共有リンクも使える。
- **秘密情報の暗号鍵は Worker secret 必須**：`PHOTOS_CREDENTIAL_KEY` を必須の secret とする。
- **D1 は単一のまま監視する**：Storage 画面に使用量を表示し、80% で警告する。
- **GPS はデフォルト非公開**、ダウンロード用 URL の有効期限は既定で 5 分とする。

各決定の理由は、末尾の「決定の記録」にまとめる。

## 既存コードへの依存と前提

このリポジトリには、リモートに push されていないローカル専用ブランチが存在する前提で進める。
そのため、この計画が依存する既存コードの形を以下に明記し、実装開始時にローカルの最新ブランチ上で差分を確認する。
想定と異なっていた場合は、この節を更新してから実装に入る。

| 依存先 | 想定している現状（2026-09 時点の `main`） | Photos 側で必要な変更 |
| --- | --- | --- |
| `packages/router/src/index.ts` | `MAIL_INBOX` を `/api/inbox/*` に振り分け、その後で汎用の `/api/*` を `WORKSHOP_BACKEND` に送る | `PHOTOS` バインディングと、`/api/photos/*` と `/share/*` の分岐を、汎用 `/api/*` より前に追加する |
| `packages/router/wrangler.jsonc` | `services` に `WORKSHOP_BACKEND`、`MAIL_INBOX`、`GATEKEEPER_EMAIL`。`run_worker_first` は `/api/*` など | `{ "binding": "PHOTOS", "service": "photos" }` と、`run_worker_first` への `/share/*` を追加する |
| `packages/workshop-backend/src/inbox-auth.ts` | Access JWT か Bearer トークンを検証し、`X-Inbox-Request: 1` と Origin で CSRF を防ぐ。結果は 204 か 403 だけ | 検査部分を、要求マーカーのヘッダー名を引数に取る共通関数に切り出す |
| `packages/workshop-backend/src/server.ts` | `/api/inbox-auth` が `authorizeInboxRequest` を呼び、`amIAdmin()` で判定する | `/api/photos-auth` を追加する。判定は同じく管理者かどうかで、成功時は編集者の記録用に `{ actor }` を返す |
| `scripts/release/manifest-lib.ts` | `HANDLED_CONFIG_KEYS` に `d1_databases` がない。`workerKind` は `backend`、`router`、`gatekeeper`、`inbox` を列挙する | `d1_databases` を `$D1_<BINDING>_ID` プレースホルダーとして扱い、`workerKind` に `photos` を加える |
| `scripts/deploy.sh` | `WORKERS=(workshop-backend inbox gatekeeper-email router)`。Access の有無を検出し、secret を Worker ごとに設定する | `photos` を router より前に加える。`PHOTOS_CREDENTIAL_KEY` がなければ生成し、Access を検出しなかったときだけ `PHOTOS_DIRECT_SHARE` を設定する |
| `packages/workshop-frontend/src/routes/` | TanStack Router のファイルベースルート（`inbox.tsx` など） | `photos.tsx` とその子ルートを追加する |
| `packages/workshop-frontend/src/components/AppShell/Sidebar.tsx` | `SidebarItem to="/inbox"` が並ぶ | Photos の項目を一つ追加する |
| `packages/i18n/src/locales/{en,ja}.ts` | キーは `workshop-frontend.<Component>.<key>` 形式 | `workshop-frontend.Photos.*` を追加する |

共有ファイルへの変更は上表の九か所に限り、残りは新規ディレクトリの中で完結させる。
ローカル専用ブランチとの衝突が起きうるのはこの九か所なので、各 PR ではこれらの変更を独立したコミットに分ける。

実装開始時の確認手順は次のとおり。

```sh
git fetch --all
git branch -vv                       # ローカル専用ブランチ（upstream なし）を洗い出す
git log --oneline main..<branch>     # 各ブランチの未 push コミット
git diff main...<branch> --stat -- \
  packages/router packages/workshop-backend/src/server.ts \
  packages/workshop-backend/src/inbox-auth.ts scripts/release/manifest-lib.ts scripts/deploy.sh \
  packages/workshop-frontend/src/routes packages/workshop-frontend/src/components/AppShell \
  packages/i18n/src/locales
```

## 全体構成

```text
Browser (workshop-frontend /photos)
   │  REST + X-Photos-Request: 1
   ▼
router ──/api/photos/*, /share/*──▶ photos Worker (Hono)
                                        │
            ┌───────────────────────────┼─────────────────────────┐
            ▼                           ▼                         ▼
       D1 PHOTOS_DB              Durable Objects            Storage Provider
       永続メタデータ              PhotoJobsDO (一つ)          ├ r2-binding (PHOTOS_BUCKET)
                                 NasAgentDO (NAS ごと)       ├ r2-s3 (別アカウント R2)
                                   ▲  WebSocket (指示)       └ nas ──HTTP──▶ Tunnel ──▶ Agent
                                   └──────────────────────────────────────────── Agent
            │
            ▼
     WORKSHOP_AUTH (workshop-backend /api/photos-auth)

Publication Job ──▶ 別アカウント R2 (S3 API) ──▶ Film Gallery、一時共有ギャラリーが manifest を読む
```

D1 と DO の役割分担は次の基準で決める。

- **D1**：一覧、検索、絞り込みの対象になるもの。NAS がオフラインでも読めなければならないもの。
- **DO**：数分から数時間続く処理の進行状態、alarm による再試行、NAS Agent との接続。これらを D1 に置くと、進行中の更新が検索用テーブルへの書き込み競合を生むためである。

DO が確定させた結果（取り込み済みの Photo、接続状態の変化）は、DO から D1 へ書き込む。
UI は通常 D1 だけを読み、進行中のジョブを表示するときに限り DO を読む。

## ディレクトリ構成

```text
packages/photos/
├── README.md
├── package.json                 # @gadgets/photos
├── wrangler.jsonc
├── deploy-inputs.json           # PHOTOS_CREDENTIAL_KEY（secret）
├── vite.config.ts               # test タスク（scripts/vitest-task-vite-config.ts を再利用）
├── vitest.config.ts
├── tsconfig.json
├── worker-configuration.d.ts    # scripts/generate-worker-types.ts で生成
├── migrations/                  # D1 マイグレーション（連番、適用済みは編集しない）
│   └── 0001_init.sql
├── shared/                      # フロントエンドと Agent も使う型と純粋関数（Worker 依存なし）
│   ├── api-types.ts             # REST の入出力型
│   ├── ids.ts                   # ID の接頭辞と生成
│   ├── visibility.ts            # 公開状態とダウンロード可否の解決
│   ├── search-query.ts          # 検索条件の型と検証
│   ├── exif.ts                  # 正規化 EXIF の型と変換
│   ├── agent-protocol.ts        # NAS Agent との WebSocket メッセージ
│   └── publication-manifest.ts  # Manifest v1 の型（Film Gallery 側もこれを写す）
├── workers/
│   ├── app.ts                   # Hono アプリ、認証ミドルウェア、DO の export
│   ├── env.ts
│   ├── auth.ts                  # WORKSHOP_AUTH 呼び出し
│   ├── db/
│   │   ├── migrate.ts           # 起動時のスキーマ適用（後述）
│   │   ├── photos.ts
│   │   ├── assets.ts
│   │   ├── albums.ts
│   │   ├── tags.ts
│   │   ├── photographers.ts
│   │   ├── storage-connections.ts
│   │   ├── publications.ts
│   │   ├── usage.ts             # D1 使用量の記録
│   │   └── search.ts            # SearchQuery → SQL
│   ├── routes/
│   │   ├── photos.ts
│   │   ├── bulk.ts
│   │   ├── albums.ts
│   │   ├── tags.ts
│   │   ├── photographers.ts
│   │   ├── storage.ts
│   │   ├── imports.ts
│   │   ├── uploads.ts
│   │   ├── downloads.ts         # /blob/:token を含む
│   │   ├── publications.ts
│   │   ├── share.ts             # /share/*（認証なし、PHOTOS_DIRECT_SHARE のときだけ）
│   │   └── agent.ts             # NAS Agent の WebSocket 接続とペアリング
│   ├── storage/
│   │   ├── provider.ts          # StorageProvider インターフェース
│   │   ├── registry.ts          # StorageConnection → StorageProvider
│   │   ├── r2-binding.ts
│   │   ├── r2-s3.ts             # aws4fetch で SigV4 署名
│   │   ├── nas.ts
│   │   ├── credentials.ts       # 秘密情報の暗号化と復号
│   │   └── blob-token.ts        # Worker 経由配信用の短期トークン
│   ├── publication/
│   │   ├── target.ts            # PublicationTarget インターフェース
│   │   ├── film-gallery.ts
│   │   ├── temporary-share.ts   # 一時共有ギャラリー
│   │   └── manifest.ts
│   └── durableObject/
│       ├── photo-jobs.ts        # PhotoJobsDO
│       ├── nas-agent.ts         # NasAgentDO
│       └── schema.ts            # SchemaMigratorDO（D1 マイグレーションの直列化）
└── __tests__/

packages/photo-storage-agent/    # NAS に置く Agent（Node、Docker イメージ）
├── README.md
├── package.json                 # 依存: exifr, sharp, ws（監視は Node の fs.watch＝inotify）
├── Dockerfile
├── docker-compose.example.yml   # agent + cloudflared、logging: none
├── src/
│   ├── main.ts
│   ├── config.ts                # /config/agent.json（読み込みは起動時の一回だけ）
│   ├── control.ts               # NasAgentDO への WebSocket、再接続
│   ├── watcher.ts               # Incoming の監視と書き込み完了待ち
│   ├── scanner.ts               # フォルダ走査（Import 画面の「428 photos found」）
│   ├── hash.ts                  # SHA-256
│   ├── exif.ts                  # shared/exif.ts と同じ正規化
│   ├── derive.ts                # preview と thumbnail の生成、RAW 埋め込み JPEG の抽出
│   ├── uploader.ts              # 署名付き PUT で R2 へ
│   ├── schedule.ts              # 定期処理の時間帯制御
│   └── server.ts                # Tunnel 越しの読み出し専用 HTTP
└── __tests__/

packages/workshop-frontend/src/
├── routes/photos.tsx            # 以下、子ルートは photos.*.tsx
├── pages/photos/PhotosPage.tsx
└── features/photos/
    ├── api.ts                   # fetch ラッパー（features/inbox/api.ts と同じ流儀）
    ├── PhotosNavigation.tsx     # 左ペイン
    ├── LibraryGrid.tsx          # 仮想スクロールのグリッド
    ├── Inspector.tsx
    ├── BulkEditBar.tsx
    ├── ImportScreen.tsx
    ├── StorageSettings.tsx      # D1 使用量の表示を含む
    ├── PublishDialog.tsx
    ├── ShareDialog.tsx
    ├── SearchBar.tsx            # 文字列 ⇄ SearchQuery の相互変換
    └── clientDerive.ts          # ブラウザでのサムネイル生成と EXIF 読み取り
```

`photo-storage-agent` は Worker ではないため、`wrangler.jsonc` を持たせない。
`readDeployablePackages` は `wrangler.jsonc` の有無だけでデプロイ対象を判定するので、これでリリースパイプラインの対象から外れる。

## D1 スキーマ

ライブラリはデプロイ全体で一つなので、テーブルに所有者の列は持たない。
時刻はミリ秒の UNIX 時間（INTEGER）、ID は接頭辞付きの ULID（TEXT）とする。
ULID にしたのは、時刻順に並ぶため `ORDER BY id` がそのまま登録順になり、カーソル型ページングの鍵に使えるからである。
`created_by` と `updated_by` には、`/api/photos-auth` が返す `actor`（Access 構成ではメールアドレス、それ以外では Cloudflare OS の利用者名）を入れる。

```sql
-- migrations/0001_init.sql

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

-- ─── ストレージ ───────────────────────────────────────────────

CREATE TABLE storage_connections (
  id                TEXT PRIMARY KEY,              -- stc_...
  kind              TEXT NOT NULL CHECK (kind IN ('r2-binding', 'r2-s3', 'nas')),
  name              TEXT NOT NULL,                 -- 「NAS / Photography」「R2 Photos Cache」
  -- 種類ごとの非秘密設定（bucket、endpoint、prefix、NAS のルートパス、Tunnel のホスト名など）
  config_json       TEXT NOT NULL,
  -- 秘密情報（S3 の secret、Tunnel 用の Access service token、Agent の公開鍵以外の鍵）。
  -- 先頭 1 バイトが鍵の版番号、続けて AES-GCM の nonce と暗号文
  secret_ciphertext BLOB,
  -- どの役割に使ってよいか（原本、派生画像、複製）
  roles             TEXT NOT NULL DEFAULT '["original","derivative","replica"]',
  status            TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (status IN ('online', 'offline', 'error', 'unknown')),
  status_detail     TEXT,
  last_seen_at      INTEGER,
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- ─── 撮影者 ───────────────────────────────────────────────────

CREATE TABLE photographers (
  id                TEXT PRIMARY KEY,              -- pgr_...
  name              TEXT NOT NULL,
  display_name      TEXT,
  avatar_asset_key  TEXT,
  website           TEXT,
  social_json       TEXT NOT NULL DEFAULT '{}',    -- {"x": "...", "instagram": "..."}
  copyright         TEXT,
  default_tag_ids   TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX photographers_name ON photographers (name);

-- EXIF Artist の文字列から撮影者への自動関連付け
CREATE TABLE photographer_aliases (
  artist_text       TEXT PRIMARY KEY,              -- 正規化済み（NFKC、前後空白除去、小文字化）
  photographer_id   TEXT NOT NULL REFERENCES photographers (id) ON DELETE CASCADE
);

-- ─── 写真 ─────────────────────────────────────────────────────

CREATE TABLE photos (
  id                    TEXT PRIMARY KEY,          -- pho_...
  title                 TEXT,
  caption               TEXT,
  -- 表示と並び替えの基準。EXIF がなければファイルの更新日時、それもなければ登録日時
  taken_at              INTEGER,
  taken_at_source       TEXT NOT NULL DEFAULT 'exif'
                        CHECK (taken_at_source IN ('exif', 'file', 'import', 'manual')),
  timezone_offset_min   INTEGER,
  photographer_id       TEXT REFERENCES photographers (id) ON DELETE SET NULL,
  visibility            TEXT NOT NULL DEFAULT 'private'
                        CHECK (visibility IN ('private', 'unlisted', 'public')),
  download_allowed      INTEGER NOT NULL DEFAULT 0,
  favorite              INTEGER NOT NULL DEFAULT 0,
  rating                INTEGER CHECK (rating BETWEEN 0 AND 5),
  -- 一覧表示に使う Asset
  cover_thumbnail_asset_id TEXT,
  cover_preview_asset_id   TEXT,
  width                 INTEGER,                   -- 向き補正後
  height                INTEGER,
  -- 知覚ハッシュ（Phase 7）。関連画像候補の検出用
  phash                 TEXT,
  created_by            TEXT NOT NULL,
  updated_by            TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER                    -- 論理削除（ゴミ箱）
);
CREATE INDEX photos_taken   ON photos (deleted_at, taken_at DESC, id DESC);
CREATE INDEX photos_created ON photos (deleted_at, created_at DESC, id DESC);
CREATE INDEX photos_fav     ON photos (favorite, taken_at DESC);
CREATE INDEX photos_vis     ON photos (visibility, taken_at DESC);
CREATE INDEX photos_photographer ON photos (photographer_id, taken_at DESC);

-- 正規化 EXIF。検索対象の列だけを持つ。原文は raw_exif_key が指すストレージ上の JSON に置く
CREATE TABLE photo_exif (
  photo_id              TEXT PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
  make                  TEXT,
  model                 TEXT,                      -- 「ILCE-7M4」
  camera_label          TEXT,                      -- 表示用「Sony α7 IV」
  lens_model            TEXT,
  focal_length_mm       REAL,
  focal_length_35mm     REAL,
  f_number              REAL,
  exposure_time_s       REAL,                      -- 1/500 → 0.002
  iso                   INTEGER,
  exposure_bias_ev      REAL,
  metering_mode         TEXT,
  flash_fired           INTEGER,
  white_balance         TEXT,
  orientation           INTEGER,
  pixel_width           INTEGER,
  pixel_height          INTEGER,
  gps_lat               REAL,
  gps_lon               REAL,
  gps_alt_m             REAL,
  artist                TEXT,
  copyright             TEXT,
  raw_exif_key          TEXT,                      -- 派生ストレージ上の JSON の key
  raw_exif_connection_id TEXT
);
CREATE INDEX photo_exif_camera ON photo_exif (model);
CREATE INDEX photo_exif_lens   ON photo_exif (lens_model);
CREATE INDEX photo_exif_iso    ON photo_exif (iso);
CREATE INDEX photo_exif_focal  ON photo_exif (focal_length_35mm);

-- 写真を構成するファイル。一枚の Photo に複数の Asset
CREATE TABLE photo_assets (
  id                TEXT PRIMARY KEY,              -- ast_...
  photo_id          TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  role              TEXT NOT NULL
                    CHECK (role IN ('original', 'replica', 'preview', 'thumbnail', 'sidecar')),
  -- 原本とその複製の組を表す。replica は対応する original の id を指す
  replica_of_asset_id TEXT REFERENCES photo_assets (id) ON DELETE SET NULL,
  -- RAW+JPEG のどちらか。preview と thumbnail は NULL
  format_family     TEXT CHECK (format_family IN ('raw', 'jpeg', 'heif', 'png', 'webp', 'avif', 'tiff', 'other')),
  is_primary        INTEGER NOT NULL DEFAULT 0,    -- 表示とダウンロード既定に使う原本
  connection_id     TEXT NOT NULL REFERENCES storage_connections (id),
  storage_key       TEXT NOT NULL,                 -- bucket 内 key、または NAS ルートからの相対パス
  original_filename TEXT,
  mime_type         TEXT NOT NULL,
  byte_size         INTEGER NOT NULL,
  sha256            TEXT,                          -- 派生画像では省略可
  width             INTEGER,
  height            INTEGER,
  state             TEXT NOT NULL DEFAULT 'available'
                    CHECK (state IN ('pending', 'available', 'missing', 'deleting')),
  verified_at       INTEGER,                       -- 最後にハッシュを照合した時刻
  created_at        INTEGER NOT NULL
);
CREATE INDEX photo_assets_photo  ON photo_assets (photo_id, role);
CREATE INDEX photo_assets_dedupe ON photo_assets (sha256, byte_size);
CREATE UNIQUE INDEX photo_assets_location ON photo_assets (connection_id, storage_key);

-- ─── タグ ─────────────────────────────────────────────────────

CREATE TABLE tags (
  id                TEXT PRIMARY KEY,              -- tag_...
  parent_id         TEXT REFERENCES tags (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  -- 祖先を含む実体化パス。「/event/kemocon/」。前方一致で子孫を引く
  path              TEXT NOT NULL UNIQUE,
  color             TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE photo_tags (
  photo_id          TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  tag_id            TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'photographer')),
  PRIMARY KEY (photo_id, tag_id)
);
CREATE INDEX photo_tags_tag ON photo_tags (tag_id, photo_id);

-- ─── アルバム ─────────────────────────────────────────────────

CREATE TABLE albums (
  id                TEXT PRIMARY KEY,              -- alb_...
  title             TEXT NOT NULL,
  description       TEXT,
  cover_photo_id    TEXT REFERENCES photos (id) ON DELETE SET NULL,
  visibility        TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'unlisted', 'public')),
  -- NULL は写真側の設定に従う。0/1 は写真側を上書きする
  download_override INTEGER,
  -- 公開時の EXIF 開示設定（ExposurePolicy の JSON）。NULL は既定値
  exposure_policy_json TEXT,
  sort_order        TEXT NOT NULL DEFAULT 'taken_at_asc',
  created_by        TEXT NOT NULL,
  updated_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX albums_updated ON albums (updated_at DESC);

CREATE TABLE album_photos (
  album_id          TEXT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
  photo_id          TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  position          REAL NOT NULL,                 -- 手動並び替え用（間に挿入できるよう REAL）
  added_at          INTEGER NOT NULL,
  PRIMARY KEY (album_id, photo_id)
);
CREATE INDEX album_photos_photo ON album_photos (photo_id);

-- ─── 公開 ─────────────────────────────────────────────────────

CREATE TABLE publication_targets (
  id                TEXT PRIMARY KEY,              -- ptg_...
  kind              TEXT NOT NULL CHECK (kind IN ('film-gallery', 'temporary-share')),
  name              TEXT NOT NULL,
  -- 書き込み先（通常は別アカウントの r2-s3 接続）
  connection_id     TEXT NOT NULL REFERENCES storage_connections (id),
  config_json       TEXT NOT NULL,                 -- prefix、公開 URL の基点など
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE publications (
  id                TEXT PRIMARY KEY,              -- pub_...
  target_id         TEXT NOT NULL REFERENCES publication_targets (id),
  album_id          TEXT REFERENCES albums (id) ON DELETE SET NULL,
  -- 一時共有では推測できない乱数、Film Gallery では人が読める slug
  slug              TEXT NOT NULL,
  exposure_policy_json TEXT NOT NULL,
  expires_at        INTEGER,                       -- 一時共有の期限。PhotoJobsDO の alarm が取り下げる
  state             TEXT NOT NULL DEFAULT 'draft'
                    CHECK (state IN ('draft', 'publishing', 'published', 'unpublishing', 'unpublished', 'failed')),
  manifest_revision INTEGER NOT NULL DEFAULT 0,
  published_at      INTEGER,
  last_error        TEXT,
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (target_id, slug)
);

-- 公開先へ複製した Asset。再公開時の差分計算と取り下げ時の削除に使う
CREATE TABLE publication_objects (
  publication_id    TEXT NOT NULL REFERENCES publications (id) ON DELETE CASCADE,
  photo_id          TEXT NOT NULL,
  variant           TEXT NOT NULL CHECK (variant IN ('thumbnail', 'preview', 'original')),
  target_key        TEXT NOT NULL,
  sha256            TEXT NOT NULL,
  PRIMARY KEY (publication_id, photo_id, variant)
);

-- ─── 直接共有リンク（PHOTOS_DIRECT_SHARE のときだけ使う） ─────

CREATE TABLE share_links (
  token_hash        TEXT PRIMARY KEY,              -- SHA-256。トークン本体は保存しない
  album_id          TEXT REFERENCES albums (id) ON DELETE CASCADE,
  photo_id          TEXT REFERENCES photos (id) ON DELETE CASCADE,
  exposure_policy_json TEXT NOT NULL,
  expires_at        INTEGER,
  revoked_at        INTEGER,
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  CHECK ((album_id IS NULL) <> (photo_id IS NULL))
);

-- ─── 使用量の記録 ─────────────────────────────────────────────

CREATE TABLE usage_samples (
  sampled_at        INTEGER PRIMARY KEY,
  d1_bytes          INTEGER NOT NULL,              -- D1 の応答 meta.size_after
  photo_count       INTEGER NOT NULL
);
```

D1 の外部キー制約は既定で有効なので、`ON DELETE CASCADE` はそのまま効く。
主な一覧は `(deleted_at, taken_at DESC, id DESC)` のカーソル型ページングで引く。

EXIF 原文を D1 に入れない理由は二つある。
一つは容量で、原文 JSON は一枚あたり数 KB から数十 KB になり、D1 の 10GB 上限に写真の枚数で直接効いてくる。
もう一つは、検索に使わない列が行を太らせ、一覧クエリで読むページ数が増えることである。
原文は派生画像と同じストレージに `exif/<photoId>.json` として置き、Inspector の詳細表示のときだけ読む。

### スキーマの適用方法

D1 マイグレーションは、Worker 自身が起動時に適用する。
`wrangler d1 migrations apply` に頼ると、顧客環境へのデプロイでデプロイサービスがマイグレーションを実行する必要があり、`manifest-lib.ts` のマニフェスト契約を広げることになるからである。

- `migrations/*.sql` はビルド時に `src/generated/migrations.ts` へ文字列として取り込む（format-blueprints と同じ方式）。
- 最初のリクエストで単一インスタンスの `SchemaMigratorDO`（`idFromName("schema")`）を呼び、その中で `schema_migrations` を見て未適用分を `db.batch()` で適用する。DO を経由するのは、複数のインスタンスが同時に適用を始めるのを防ぐためである。
- 適用済みのバージョンは Worker のメモリに保持し、以後は確認を省く。

それでも `d1_databases` バインディング自体はマニフェストに載せる必要がある。
`manifest-lib.ts` の変更は golden ファイルの更新を伴うため、Photos 本体とは別の PR にする。

### D1 使用量の監視

D1 はクエリ結果の `meta.size_after` でデータベースの大きさを返す。
`PhotoJobsDO` の alarm が一日一回 `SELECT COUNT(*) FROM photos` を実行し、その `size_after` と枚数を `usage_samples` に記録する。
Storage 画面は最新の記録から使用量と一枚あたりの平均を表示し、10GB の 80% を超えたら警告を出す。

一枚あたりの大きさは、写真の行、EXIF、Asset 四つ、タグ数件、索引で約 2KB と見積もっており、これが正しければ上限はおよそ 500 万枚になる。
この 2KB は机上の値なので、Phase 1 で数千枚の試験データを入れて実測し、この節を更新する。
上限に近づいた場合の分割（撮影年ごとの D1 など）は、その時点で設計する。

## Durable Object のスキーマ

### PhotoJobsDO（デプロイで一つ、`idFromName("library")`）

Import、Upload、Publication の各ジョブと、一時共有の期限切れ処理、D1 使用量の記録を持つ。
一つにまとめたのは、ジョブ同士の重複（同じフォルダの二重取り込みなど）を一か所で直列に判定できるからである。

```sql
CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,               -- job_...
  kind           TEXT NOT NULL,                  -- 'import' | 'upload' | 'publish' | 'unpublish' | 'replicate' | 'move'
  state          TEXT NOT NULL,                  -- 'queued' | 'running' | 'waiting-agent' | 'succeeded' | 'failed' | 'cancelled'
  params_json    TEXT NOT NULL,
  total          INTEGER NOT NULL DEFAULT 0,
  done           INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- ジョブ内の一件ごとの状態。再開時にここから続ける
CREATE TABLE job_items (
  job_id         TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  source_ref     TEXT NOT NULL,                  -- NAS の相対パス、アップロードのクライアント側 ID など
  state          TEXT NOT NULL,                  -- 'pending' | 'hashing' | 'registered' | 'deriving' | 'done' | 'duplicate' | 'failed'
  photo_id       TEXT,
  attempt        INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  PRIMARY KEY (job_id, seq)
);

-- ブラウザからのアップロード。署名付き PUT の発行から完了確認まで
CREATE TABLE upload_sessions (
  id             TEXT PRIMARY KEY,               -- upl_...
  job_id         TEXT NOT NULL,
  connection_id  TEXT NOT NULL,
  storage_key    TEXT NOT NULL,
  expected_size  INTEGER NOT NULL,
  expected_sha256 TEXT NOT NULL,
  multipart_upload_id TEXT,
  expires_at     INTEGER NOT NULL
);
```

alarm は、実行中ジョブの次の一件の処理、期限切れの `upload_sessions` の片付け（R2 の未完了マルチパートの abort）、期限切れの一時共有の取り下げ、一日一回の使用量の記録に使う。

### NasAgentDO（NAS 接続ごと、`idFromName(connectionId)`）

Agent が張る WebSocket を、Hibernatable WebSocket API で受ける。
keepalive には `setWebSocketAutoResponse` を使い、ping に対する pong を DO を起こさずにランタイムが返すようにする。
これで、待機中は Agent も DO もアプリケーションのコードを動かさない。

```sql
CREATE TABLE agent_state (
  singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
  agent_version     TEXT,
  public_key        TEXT NOT NULL,               -- ペアリング時に登録した Ed25519 公開鍵
  status            TEXT NOT NULL,               -- 'online' | 'offline'
  connected_at      INTEGER,
  disconnected_at   INTEGER,
  watch_cursor      TEXT                         -- Incoming 監視の再開位置
);

-- Agent からの通知の重複排除（Agent は再接続時に未確認の通知を再送する）
CREATE TABLE agent_events_seen (
  event_id          TEXT PRIMARY KEY,
  received_at       INTEGER NOT NULL
);

-- Agent がオフラインの間に溜まった指示。再接続時に順に送る
CREATE TABLE pending_commands (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  command_json      TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
```

オフラインの判定は二段にする。

- `webSocketClose` か `webSocketError` を受けたら、ただちに `offline` にする。
- 切断が通知されない場合（NAS の電源断や回線断）に備え、alarm で 3 分ごとに `getWebSocketAutoResponseTimestamp` を見て、最後の ping から 3 分以上経っていれば `offline` にする。

状態が変わったときだけ D1 の `storage_connections.status` を更新し、`online` に戻ったら `PhotoJobsDO` に通知して `waiting-agent` のジョブを再開させる。

## TypeScript の型

### ID と公開状態（`shared/ids.ts`、`shared/visibility.ts`）

```ts
/** Prefixed ULID so an id's kind is visible in logs and URLs. */
export type PhotoId = `pho_${string}`;
export type AssetId = `ast_${string}`;
export type AlbumId = `alb_${string}`;
export type TagId = `tag_${string}`;
export type PhotographerId = `pgr_${string}`;
export type StorageConnectionId = `stc_${string}`;
export type PublicationTargetId = `ptg_${string}`;
export type PublicationId = `pub_${string}`;
export type JobId = `job_${string}`;

export type Visibility = "private" | "unlisted" | "public";

/** What a published or shared view may reveal. GPS is opt-in everywhere. */
export interface ExposurePolicy {
  camera: boolean;          // make, model, lens, exposure settings
  photographer: boolean;
  takenAt: boolean;
  gps: boolean;             // default false
  downloadOriginal: boolean;
  downloadPreview: boolean;
}

export const DEFAULT_EXPOSURE_POLICY: ExposurePolicy = {
  camera: true, photographer: true, takenAt: true,
  gps: false, downloadOriginal: false, downloadPreview: true,
};

/**
 * Whether a shared or published view may offer a download. An album override applies only to
 * views of that album; library members (admins) can always download.
 */
export function resolveDownloadAllowed(
  photo: { downloadAllowed: boolean },
  album?: { downloadOverride: boolean | null },
): boolean {
  return album?.downloadOverride ?? photo.downloadAllowed;
}
```

### API で受け渡す型（`shared/api-types.ts`）

```ts
export type AssetRole = "original" | "replica" | "preview" | "thumbnail" | "sidecar";
export type FormatFamily = "raw" | "jpeg" | "heif" | "png" | "webp" | "avif" | "tiff" | "other";
export type StorageKind = "r2-binding" | "r2-s3" | "nas";
export type ConnectionStatus = "online" | "offline" | "error" | "unknown";

export interface NormalizedExif {
  takenAt?: number;
  timezoneOffsetMin?: number;
  make?: string;
  model?: string;
  lensModel?: string;
  focalLengthMm?: number;
  focalLength35mm?: number;
  fNumber?: number;
  exposureTimeS?: number;
  iso?: number;
  exposureBiasEv?: number;
  meteringMode?: string;
  flashFired?: boolean;
  whiteBalance?: string;
  orientation?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  gps?: { lat: number; lon: number; altM?: number };
  artist?: string;
  copyright?: string;
}

export interface PhotoSummary {
  id: PhotoId;
  takenAt: number | null;
  width: number | null;
  height: number | null;
  favorite: boolean;
  visibility: Visibility;
  thumbnailUrl: string | null;   // 短期の配信 URL。期限切れなら一覧を再取得する
  hasRaw: boolean;
  originalAvailable: boolean;    // 原本がすべてオフラインの NAS にしかなければ false
}

export interface AssetView {
  id: AssetId;
  role: AssetRole;
  formatFamily: FormatFamily | null;
  isPrimary: boolean;
  connection: { id: StorageConnectionId; name: string; kind: StorageKind; status: ConnectionStatus };
  storageKey: string;
  originalFilename: string | null;
  byteSize: number;
  sha256: string | null;
  state: "pending" | "available" | "missing" | "deleting";
}

export interface PhotoDetail extends PhotoSummary {
  title: string | null;
  caption: string | null;
  rating: number | null;
  downloadAllowed: boolean;
  photographer: PhotographerView | null;
  photographerSuggestion: PhotographerView | null;   // EXIF Artist からの候補
  exif: NormalizedExif | null;
  tags: TagView[];
  albums: { id: AlbumId; title: string }[];
  assets: AssetView[];
  previewUrl: string | null;
  createdBy: string;
  updatedBy: string;
}

export interface PhotoPatch {
  title?: string | null;
  caption?: string | null;
  photographerId?: PhotographerId | null;
  visibility?: Visibility;
  downloadAllowed?: boolean;
  favorite?: boolean;
  rating?: number | null;
  takenAt?: number;              // 手動補正。taken_at_source を 'manual' にする
}

/** Bulk edit applies the same change to every selected photo in one D1 batch. */
export interface BulkPhotoEdit {
  photoIds: PhotoId[];           // 上限 500
  set?: Pick<PhotoPatch, "photographerId" | "visibility" | "downloadAllowed" | "favorite">;
  addTagIds?: TagId[];
  removeTagIds?: TagId[];
  addToAlbumIds?: AlbumId[];
  removeFromAlbumIds?: AlbumId[];
}

export interface TagView { id: TagId; parentId: TagId | null; name: string; path: string; color: string | null }
export interface PhotographerView {
  id: PhotographerId; name: string; displayName: string | null;
  website: string | null; social: Record<string, string>; copyright: string | null;
}

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface LibraryUsage {
  d1Bytes: number;
  d1LimitBytes: number;          // 10GB
  photoCount: number;
  bytesPerPhoto: number;
  warning: boolean;              // 80% 超
  sampledAt: number;
}
```

### 検索条件（`shared/search-query.ts`）

検索は API では構造化した JSON で受け取り、文字列（`camera:"α7 IV" iso<=800 tag:event`）との相互変換はフロントエンドの `SearchBar.tsx` が受け持つ。
サーバーが文字列を解釈しないのは、SQL を組み立てる側の入力を列挙型と数値に限定しておきたいからである。

```ts
export type NumericField = "iso" | "fNumber" | "focalLengthMm" | "focalLength35mm" | "exposureTimeS" | "rating";
export type NumericOp = "eq" | "lt" | "lte" | "gt" | "gte";

export interface SearchQuery {
  text?: string;                         // title、caption、ファイル名の部分一致
  cameraModels?: string[];
  lensModels?: string[];
  photographerIds?: PhotographerId[];
  tagIds?: TagId[];                      // 子孫タグも含めて一致させる
  tagMatch?: "all" | "any";
  albumId?: AlbumId;
  visibility?: Visibility[];
  favorite?: boolean;
  hasRaw?: boolean;
  takenFrom?: number;
  takenTo?: number;
  numeric?: { field: NumericField; op: NumericOp; value: number }[];
  connectionId?: StorageConnectionId;    // Storage 画面から「この NAS にある写真」
  sort?: "taken_desc" | "taken_asc" | "created_desc";
}
```

### Storage Provider（`workers/storage/provider.ts`）

構想の `StorageProvider` から二点変えている。
一点目は `createUpload` を加えたことで、ブラウザや Agent から直接書き込ませるために必要になる。
二点目は `read` と `write` を Worker 内部の処理（小さな派生画像や EXIF 原文、公開先への複製、NAS 原本の中継）に限ったことで、利用者のダウンロードとアップロードは `createDownload` と `createUpload` を経由させる。

```ts
export interface StorageObject {
  key: string;
  size: number;
  modifiedAt: number;
  etag?: string;
}

export type DownloadTarget =
  | { kind: "redirect"; url: string; expiresAt: number }   // 署名付き GET か、自前の /blob/:token
  | { kind: "unavailable"; reason: "offline" | "missing" };

export type UploadTarget =
  | { kind: "presigned-put"; url: string; headers: Record<string, string>; expiresAt: number }
  | { kind: "multipart"; uploadId: string; partUrls: string[]; partSize: number; expiresAt: number }
  | { kind: "worker-proxy"; url: string; expiresAt: number };

export interface DownloadOptions {
  filename?: string;              // Content-Disposition
  ttlSeconds?: number;            // 既定 300
}

export interface StorageProvider {
  readonly kind: StorageKind;
  testConnection(): Promise<{ status: ConnectionStatus; detail?: string }>;
  list(prefix: string, cursor?: string): Promise<{ objects: StorageObject[]; cursor?: string }>;
  stat(key: string): Promise<StorageObject | null>;
  read(key: string, range?: { offset: number; length: number }): Promise<ReadableStream | null>;
  write(key: string, data: ReadableStream | ArrayBuffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  createDownload(key: string, options?: DownloadOptions): Promise<DownloadTarget>;
  createUpload(key: string, size: number, contentType: string): Promise<UploadTarget>;
}
```

`registry.ts` は `storage_connections` の一行から `StorageProvider` を作る唯一の場所とし、秘密情報の復号もここでだけ行う。
復号した値を Provider の外へ返す経路を作らないためである。

### Publication Target と Manifest（`workers/publication/target.ts`、`shared/publication-manifest.ts`）

```ts
export interface PublicationTarget {
  readonly kind: "film-gallery" | "temporary-share";
  /** Copy assets first, manifest last, so a reader never sees a manifest pointing at missing files. */
  publish(input: PublishInput): Promise<{ revision: number }>;
  unpublish(publicationId: PublicationId): Promise<void>;
}

export interface PublishInput {
  publication: { id: PublicationId; slug: string; revision: number; expiresAt: number | null };
  album: { title: string; description: string | null };
  photos: PublishablePhoto[];      // ExposurePolicy 適用済み。GPS は policy.gps が true のときだけ入る
  policy: ExposurePolicy;
}

/** The only contract between Photos and an external gallery. Versioned; readers ignore unknown fields. */
export interface PublicationManifestV1 {
  schema: "cloudflare-os.photos.publication/v1";
  publicationId: string;
  revision: number;
  generatedAt: string;             // ISO 8601
  expiresAt?: string;              // 一時共有のみ。読み手は期限後に表示しない
  album: { slug: string; title: string; description?: string };
  photos: {
    id: string;                    // 公開用の不透明 ID（内部の PhotoId は出さない）
    width: number;
    height: number;
    takenAt?: string;
    photographer?: { name: string; website?: string; copyright?: string };
    camera?: { model?: string; lens?: string; focalLength35mm?: number; fNumber?: number; exposureTime?: string; iso?: number };
    gps?: { lat: number; lon: number };
    files: {
      thumbnail: { key: string; sha256: string };
      preview: { key: string; sha256: string };
      original?: { key: string; sha256: string; filename: string };   // downloadOriginal のときだけ
    };
  }[];
}
```

公開用の写真 ID を内部の `PhotoId` と分けるのは、公開先から Photos 内部の識別子を推測させないためである。
公開用 ID は `HMAC(publicationId, photoId)` から作り、同じ公開の再生成で変わらないようにする。

### NAS Agent とのやりとり（`shared/agent-protocol.ts`）

```ts
/** Agent → NasAgentDO over the control WebSocket. */
export type AgentMessage =
  | { type: "hello"; version: string; signature: string; timestamp: number; nonce: string }
  | { type: "file-discovered"; eventId: string; path: string; size: number; mtime: number; sha256: string; exif: NormalizedExif | null }
  | { type: "scan-result"; eventId: string; jobId: JobId; files: { path: string; size: number; sha256: string }[]; done: boolean }
  | { type: "derivatives-uploaded"; eventId: string; photoId: PhotoId; preview: DerivedFile; thumbnail: DerivedFile }
  | { type: "replica-uploaded"; eventId: string; assetId: AssetId; targetKey: string; sha256: string }
  | { type: "deleted"; eventId: string; jobId: JobId; path: string }
  | { type: "file-missing"; eventId: string; path: string }
  | { type: "ack"; commandSeq: number };

export interface DerivedFile { key: string; size: number; sha256: string; width: number; height: number }

/** NasAgentDO → Agent. Each carries a seq; the agent acks it after acting. */
export type AgentCommand =
  | { seq: number; type: "scan"; jobId: JobId; folder: string }
  | { seq: number; type: "derive"; jobId: JobId; photoId: PhotoId; path: string; upload: { preview: UploadTarget; thumbnail: UploadTarget } }
  | { seq: number; type: "replicate"; jobId: JobId; assetId: AssetId; path: string; upload: UploadTarget }
  | { seq: number; type: "delete-after-verify"; jobId: JobId; path: string; expectedSha256: string };
```

原本の読み出しは WebSocket に流さず、Worker が Tunnel 越しに Agent の `GET /files/<path>` を呼ぶ（「NAS」の節）。
WebSocket に大きなファイルを流すと、DO がそのデータを一度メモリに受けることになるからである。

`delete-after-verify` は「移動」取り込み専用で、Worker が複製先の `sha256` と `byte_size` を照合し終えてからしか送らない。
Agent 側でも削除直前に原本のハッシュを再計算し、`expectedSha256` と一致しなければ削除しない。

## API エンドポイント

利用者向けの API はすべて `/api/photos/v1` 以下に置く。
これらは `X-Photos-Request: 1` ヘッダーを必須にする（Inbox の `X-Inbox-Request` と同じく、非単純ヘッダーでクロスサイトのフォーム送信を防ぐため）。
例外は三つで、`/blob/:token` はブラウザのダウンロードとして開くためヘッダーを付けられず、トークン自体で認可する。
`/agent/*` は管理者の認証ではなく Agent の署名で認可する。
`/share/*` は認証なしで、共有トークンで認可する。

### 写真

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/photos/search` | `SearchQuery` と `cursor` を受け取り `Page<PhotoSummary>` を返す。Library、Recent、Favorites、Public などの左ペインはすべてこの条件の違いで表す |
| GET | `/photos/:id` | `PhotoDetail` |
| PATCH | `/photos/:id` | `PhotoPatch` |
| DELETE | `/photos/:id` | 論理削除。`?purge=1` で Asset の削除ジョブを作る |
| POST | `/photos/:id/restore` | ゴミ箱から戻す |
| GET | `/photos/:id/exif/raw` | EXIF 原文 |
| POST | `/photos/bulk` | `BulkPhotoEdit` |
| POST | `/photos/:id/merge` | 別の Photo の原本 Asset を取り込み、RAW+JPEG の組にする |
| POST | `/photos/:id/split` | 組になった原本を別の Photo に分ける |
| GET | `/photos/:id/related` | 同一 `sha256` の重複と、Phase 7 以降は知覚ハッシュの近い候補 |

### タグ、アルバム、撮影者

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/tags` | 木構造で返す |
| POST | `/tags` | `{ name, parentId? }` |
| PATCH | `/tags/:id` | 名前、色、親の変更（子孫の `path` も書き換える） |
| DELETE | `/tags/:id` | 子孫ごと削除 |
| GET | `/albums` | 一覧 |
| POST | `/albums` | 作成 |
| GET | `/albums/:id` | 詳細（写真一覧は `/photos/search` の `albumId` で引く） |
| PATCH | `/albums/:id` | タイトル、公開状態、`downloadOverride`、`exposurePolicy` |
| DELETE | `/albums/:id` | アルバムだけ削除（写真は残す） |
| POST | `/albums/:id/photos` | `{ photoIds, position? }` |
| DELETE | `/albums/:id/photos` | `{ photoIds }` |
| PATCH | `/albums/:id/photos/order` | `{ photoId, afterPhotoId }` |
| GET | `/photographers` | 一覧 |
| POST | `/photographers` | 作成 |
| PATCH | `/photographers/:id` | 更新 |
| DELETE | `/photographers/:id` | 削除（写真側は NULL になる） |
| POST | `/photographers/:id/aliases` | `{ artistText }`。「今後この Artist を自動的に関連付ける」 |
| DELETE | `/photographers/:id/aliases/:artistText` | 関連付けの解除 |
| GET | `/photographers/suggestions` | 撮影者未設定で EXIF Artist を持つ写真を Artist ごとに集計 |

### ストレージ

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/storage` | 接続一覧と状態、各接続の Asset 数と総容量 |
| GET | `/storage/usage` | `LibraryUsage`（D1 使用量） |
| POST | `/storage` | 接続の追加。`r2-s3` は endpoint、bucket、access key、secret。`nas` は Tunnel のホスト名と Access service token を受け取り、ペアリングコードを返す |
| PATCH | `/storage/:id` | 名前、役割の変更、秘密情報の差し替え |
| DELETE | `/storage/:id` | Asset が残っていれば 409 |
| POST | `/storage/:id/test` | `testConnection()` |
| GET | `/storage/:id/browse?path=` | フォルダ一覧（Import 画面のフォルダ選択） |

### 取り込みとアップロード

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/imports/preview` | `{ connectionId, folder }` から件数、登録済み、新規を数える。NAS の場合は Agent に `scan` を送るジョブになり、結果は `/imports/:jobId` で取得する |
| POST | `/imports` | Import 画面の設定一式でジョブを作る |
| GET | `/imports` | ジョブ一覧 |
| GET | `/imports/:jobId` | 進捗と失敗一覧 |
| POST | `/imports/:jobId/cancel` | 中止 |
| POST | `/imports/:jobId/retry` | 失敗分のみ再実行 |
| POST | `/uploads` | ブラウザから。`{ files: [{ clientId, filename, size, sha256, mimeType, exif }], importOptions }` を受け取り、重複を除いたものに `UploadTarget` を返す |
| POST | `/uploads/:sessionId/complete` | 書き込み後の確認。Worker が `stat` でサイズを照合し、Photo を `available` にする |
| POST | `/uploads/:sessionId/derivatives` | ブラウザで生成したプレビューとサムネイルの `UploadTarget` を得る |

Import の設定は次の型で受け取る。

```ts
export interface ImportOptions {
  mode: "reference" | "copy" | "move";       // 既定 reference。move は確認ダイアログを必須にする
  derivativeConnectionId: StorageConnectionId;
  replicaConnectionId?: StorageConnectionId; // copy と move のとき必須
  readExif: boolean;
  detectPhotographer: boolean;
  detectDuplicates: boolean;
  generatePreviews: boolean;
  generateThumbnails: boolean;
  defaultVisibility: Visibility;
  defaultTagIds: TagId[];
  defaultAlbumId?: AlbumId;
  pairRawJpeg: boolean;                      // 同じフォルダの同名 RAW と JPEG を一つの Photo にする
}
```

### ダウンロード

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/photos/:id/download` | `{ variant: "original" \| "raw" \| "jpeg" \| "both" \| "preview" }`。`DownloadTarget` を返す。`both` は二つの URL を返す |
| GET | `/blob/:token` | Worker 経由の配信。同一アカウント R2 の派生画像と、NAS 原本の中継に使う |

ライブラリの利用者は管理者だけなので、`/photos/:id/download` は `downloadAllowed` を見ない。
`downloadAllowed` とアルバムの `downloadOverride` が効くのは、共有リンクと公開先に書き出す場面である。

`/blob/:token` のトークンは `HMAC(PHOTOS_CREDENTIAL_KEY から導出した鍵, assetId, variant, expiresAt)` とし、既定 5 分で失効する。

### 公開と共有

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/publication-targets` | 一覧 |
| POST | `/publication-targets` | `{ kind: "film-gallery" \| "temporary-share", name, connectionId, config }` |
| PATCH / DELETE | `/publication-targets/:id` | 更新、削除 |
| POST | `/publications` | `{ targetId, albumId, slug?, exposurePolicy, expiresAt? }`。ジョブを作って `publishing` にする。一時共有では `slug` を乱数で生成する |
| GET | `/publications` | 一覧と状態 |
| POST | `/publications/:id/republish` | アルバムの変更を反映（差分だけ複製） |
| POST | `/publications/:id/unpublish` | Manifest を取り下げ、複製したファイルを削除 |
| GET | `/publications/:id/manifest` | 生成される Manifest のプレビュー |
| GET | `/share-links/capability` | `{ direct: boolean }`。UI が直接共有リンクの選択肢を出すかどうかに使う |
| POST | `/share-links` | `{ albumId \| photoId, exposurePolicy, expiresAt? }`。`PHOTOS_DIRECT_SHARE` がなければ 404。トークンは作成時の応答でだけ返す |
| GET | `/share-links` | 一覧（トークン本体は返さない） |
| DELETE | `/share-links/:tokenHash` | 失効 |

直接共有リンクの閲覧側は `/api/photos/v1` の外に置く。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/share/:token` | 閲覧ページ（Photos Worker が返す単独の HTML。Workshop の SPA はログインを要求するため使わない） |
| GET | `/share/:token/data` | `ExposurePolicy` を適用済みの写真一覧 |
| GET | `/share/:token/file/:publicPhotoId/:variant` | サムネイル、プレビュー、許可されていれば原本 |

### NAS Agent 向け

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/agent/pair` | ペアリングコードと Agent の Ed25519 公開鍵を受け取り、接続に結び付ける |
| GET | `/agent/connect/:connectionId` | WebSocket へのアップグレード。`NasAgentDO` へ渡す |

## 認証と権限

### 管理者の認証

Photos を使えるのは管理者だけで、判定は Inbox と同じく `AuthenticatedApi.amIAdmin()` による。
`authorizeInboxRequest` の検査部分（Access JWT か Bearer トークン、Origin、非単純ヘッダー）を、要求マーカーのヘッダー名を引数に取る共通関数に切り出し、`/api/inbox-auth` と `/api/photos-auth` の両方から呼ぶ。
`/api/photos-auth` は成功時に `200 { actor }` を返し、Photos Worker はこれを `created_by` と `updated_by` に使う。
クライアントが送る値から `actor` を取ることはしない。

### 秘密情報の暗号化

`storage_connections.secret_ciphertext` は、Worker の secret `PHOTOS_CREDENTIAL_KEY`（32 バイトを base64 で表したもの）を鍵とする AES-GCM で暗号化する。
associated data に接続 ID を入れ、別の行に暗号文を移しても復号できないようにする。
API は秘密情報を返さず、設定済みかどうかだけを返す。

この secret は必須とし、未設定なら Photos Worker は起動時の検査で 503 を返し、Storage 画面に設定方法を表示する。
供給方法はデプロイ手段ごとに次のとおり。

- **自前デプロイ（`scripts/deploy.sh`）**：`deploy.config.json` に値がなければ `openssl rand -base64 32` で生成して設定する。既に設定済みなら上書きしない（上書きすると既存の暗号文が復号できなくなるため）。
- **デプロイウィザード**：`packages/photos/deploy-inputs.json` に `kind: "secret"` の入力欄を置き、説明文に生成コマンドを載せる。

暗号文の先頭 1 バイトを鍵の版番号にしておき、鍵を更新するときは `PHOTOS_CREDENTIAL_KEY_PREVIOUS` を併設して、読み出し時に古い版を新しい鍵で暗号化し直す。

### NAS Agent の認証

Agent と Cloudflare OS の相互認証は、向きごとに次の二つで実現する。

- **Agent から Worker（制御用 WebSocket）**：ペアリング時に Agent が Ed25519 の鍵対を作り、公開鍵を `NasAgentDO` に登録する。接続後の最初のメッセージ `hello` で、接続 ID、時刻、nonce に署名し、DO は時刻のずれ 5 分以内と nonce の未使用を確かめる。検証が済むまで他のメッセージは受け付けない。
- **Worker から Agent（Tunnel 越しの読み出し）**：Agent は Tunnel のホスト名で待ち受け、そのホスト名の前段に Cloudflare Access を置いて service token を要求する。Worker は接続設定に保存した service token を付けて呼ぶ。Agent の HTTP は読み出し専用で、`GET /files/<path>` と `GET /list/<path>` だけを持つ。書き込みや削除は WebSocket の指示でしか行わない。

Cloudflare OS 本体に Access を使っている構成では、Agent の WebSocket も Access を通る必要がある。
この場合は Cloudflare OS の Access アプリケーションに Service Auth のポリシーを追加し、Agent 用の service token を発行して `agent.json` に設定する。
この手順は `photo-storage-agent/README.md` に書く。

## ストレージの各論

### 同一アカウント R2 の署名付き URL

構想では同一アカウントの R2 に Worker のバインディングを使うとしている。
ただし、バインディングからは署名付き URL を発行できない。
署名付き URL は S3 互換 API の認証情報（access key と secret）で署名するものだからである。

そこで `r2-binding` Provider は次のように振る舞う。

- **サムネイルとプレビュー**：`/blob/:token` で Worker から配信する。数十 KB から数 MB なので、Worker を経由させても問題になりにくい。キャッシュヘッダーを付け、同じトークンの再取得はブラウザのキャッシュに任せる。
- **原本のダウンロードとアップロード**：同じバケットに限定した R2 API トークンを任意設定として受け取り、設定されていれば署名付き URL を使う。未設定なら `worker-proxy` にフォールバックし、アップロードは R2 のマルチパート API をバインディングから呼んで分割転送する。Worker のリクエスト本文の上限（プランにより 100MB から 500MB）を超えないよう、一回の送信を 1 パート（既定 32MB）に抑える。

### 別アカウント R2（`r2-s3`）

`aws4fetch` で SigV4 署名した要求を `https://<account>.r2.cloudflarestorage.com/<bucket>` に送る。
署名付き URL も同じライブラリで作る。
推奨する権限は、対象バケットだけに限定した Object Read & Write である。
Film Gallery と一時共有ギャラリーの公開先もこの Provider を使う。

ブラウザから別アカウントの R2 へ直接 PUT するには、そのバケットの CORS 設定で Cloudflare OS のオリジンを許可する必要がある。
接続の追加画面で `testConnection()` が CORS の不足を検出したら、設定例を表示する。

### NAS（`nas`）

`list`、`stat`、`read` は、Worker が Access service token を付けて Tunnel 越しに Agent の読み出し専用 HTTP を呼ぶ。
`createDownload` は `/blob/:token` を返し、ブラウザがそれを開くと Worker が `read` のストリームをそのままレスポンスに流す。
Worker は受け取ったデータを流すだけなので CPU 時間はほとんど使わず、レスポンスの大きさにも上限はない。
転送速度は、NAS の上り回線、Tunnel、Worker の三段で決まる。

NAS がオフラインなら `createDownload` は `{ kind: "unavailable", reason: "offline" }` を返す。
`write` と `createUpload` は NAS への書き戻しを想定しないため、初期実装では提供しない。

### 派生画像の生成

Worker 内で画像を縮小するには、Cloudflare Images のバインディングを使うか、Wasm の画像ライブラリを同梱する必要がある。
Images バインディングはリリースマニフェストが未対応で（`HANDLED_CONFIG_KEYS` に `images` がない）、Wasm の同梱は Worker のサイズと CPU 時間を圧迫する。
そのため、派生画像は取り込み元で作る。

- **NAS からの取り込み**：Agent が sharp（libvips）でプレビュー（長辺 2048px の JPEG）とサムネイル（長辺 400px の WebP）を作る。RAW はファイルに埋め込まれたプレビュー JPEG を取り出して使う。
- **ブラウザからのアップロード**：`createImageBitmap` と `OffscreenCanvas` で同じサイズを作る。ブラウザが復号できない形式（RAW、一部の HEIC）は、exifr で埋め込みプレビューを取り出し、それもなければサムネイルなしで登録して、Inspector に「プレビュー未生成」と表示する。

EXIF の読み取りも同じく取り込み元（Agent かブラウザ）で行い、`NormalizedExif` を送る。
Worker は値の範囲と型を検査するが、EXIF の中身の真偽は確かめない。
送り手は管理者本人か、管理者がペアリングした Agent なので、ライブラリの外の誰かが偽の値を入れる経路はない。

## NAS Storage Agent

Agent は Docker イメージとして配布し、`cloudflared` と並べて `docker-compose.example.yml` で起動する。

### HDD スリープを妨げないための要件

HDD が回り始めるのはディスクへの読み書きが起きたときで、ネットワーク通信そのものでは起きない。
Agent は待機中にディスクへ触れないよう、次を守る。

- **フォルダ監視は inotify**：Node の `fs.watch`（Linux では inotify）を使い、フォルダを定期的に読み直すポーリング方式にしない。inotify はカーネルが変更を通知する仕組みなので、待機中にディスクを読まない。
- **ログをディスクに書かない**：ログは標準出力だけに出し、`docker-compose.example.yml` では `logging: { driver: none }` を既定にする。調査が必要なときだけ利用者が切り替える。
- **設定は起動時に一度だけ読む**：`/config/agent.json` を監視したり再読込したりしない。
- **keepalive はプロトコルの ping だけ**：制御用 WebSocket の ping と pong はランタイムが処理し、Agent のアプリケーションコードは動かない。
- **定期処理は時間帯を指定する**：Incoming 以外の再スキャンと、原本の定期的なハッシュ照合（Phase 7）は、既定で無効にし、有効にする場合は実行する時間帯を `agent.json` で指定させる。
- **一時ファイルは tmpfs**：派生画像の生成に使う作業領域は `/tmp` を tmpfs にマウントする。

ただし、NAS の機種によっては Docker 自体（Synology の Container Manager など）の動作で HDD がスリープしないことがあり、Docker の保存先が SSD かどうかにもよる。
Agent 側でできるのは上の要件までで、スリープを保証するものではないことを README に明記する。

### 監視フォルダの取り込み

Agent は `/Photos/Incoming/` の変更を受けたら、サイズと mtime が 10 秒間変わらないことを確かめて書き込み完了とみなす。
その後、SHA-256 と EXIF を計算して `file-discovered` を送り、接続ごとに設定した既定の `ImportOptions` で取り込みを進める。
オフラインの間に届いたファイルは、再接続時の `hello` の後に、`watch_cursor` 以降の変更として送り直す。

## 取り込みの流れ

### ブラウザからのアップロード

1. ブラウザが各ファイルの SHA-256、EXIF、サムネイル、プレビューを作る。
2. `POST /uploads` で一覧を送る。Worker は `photo_assets_dedupe` で重複を除き、`PhotoJobsDO` にジョブと `upload_sessions` を作り、`UploadTarget` を返す。
3. ブラウザが原本と派生画像を直接書き込む。
4. `POST /uploads/:sessionId/complete` で Worker が `stat` を呼び、サイズを照合する。一致すれば D1 に Photo、Asset、EXIF、タグを一つの `batch` で書き込む。
5. 撮影者は、`photographer_aliases` に EXIF Artist の一致があれば自動で設定し、なければ `photographerSuggestion` として Inspector に出す。

ハッシュの照合をサーバー側でしないのは、照合のために原本全体を Worker で読み直すと、「大きなファイルを Worker に通さない」方針に反するからである。
ハッシュはクライアント申告値として保存し、複製や移動のときに Agent か Worker が実データで照合して `verified_at` を埋める。

### NAS からの取り込み

1. `POST /imports/preview` で `PhotoJobsDO` が `NasAgentDO` 経由で Agent に `scan` を送り、Agent が各ファイルのパス、サイズ、SHA-256 を `scan-result` で返す。
2. Worker は重複を除いた件数を Import 画面に返す。
3. `POST /imports` でジョブを開始する。`reference` なら原本 Asset を NAS の接続で登録し、Agent に `derive` を送る。
4. `copy` なら加えて `replicate` を送り、`replica-uploaded` を受けた Worker が複製先を `stat` して `replica` Asset を登録する。
5. `move` なら `copy` と同じ手順の後、複製の照合に成功したものだけ `delete-after-verify` を送り、`deleted` を受けてから NAS 側の原本 Asset を削除して複製を `original` に昇格させる。

Agent がオフラインの間に送るべき指示は `pending_commands` に溜め、ジョブは `waiting-agent` で止まる。
再接続すると `NasAgentDO` が溜まった指示を順に送り、`ack` を受けたものから消す。

### NAS がオフラインのとき

Library、検索、EXIF、タグ、アルバム、サムネイル、プレビューはすべて D1 と R2 にあるので、NAS の状態に関係なく動く。
`PhotoSummary.originalAvailable` は、`available` な原本か複製のうち、接続が `offline` でないものが一つでもあれば true になる。
ダウンロード API は、オンラインの複製があればそちらを返し、なければ `unavailable` を返す。

## 公開と共有の流れ

### Publication Target への公開

1. `POST /publications` でジョブを作る。
2. `PhotoJobsDO` が、アルバムの写真一覧と `ExposurePolicy` から `PublishInput` を組み立てる。GPS は `policy.gps` が true のときだけ含める。
3. `publication_objects` と比べて差分のファイルだけを公開先へ複製する（プレビューとサムネイルは常に、原本は `downloadOriginal` のときだけ）。
4. 最後に `manifests/<slug>.json` を書き込み、`publications.state` を `published` にする。

Manifest を最後に書くのは、読み手が Manifest を読んだ時点で、参照先のファイルがすべて揃っていることを保証するためである（リリースパイプラインがマニフェストを最後にアップロードするのと同じ理由）。
取り下げは、先に Manifest を削除してからファイルを消す。

Film Gallery 側に必要な変更は、`PublicationManifestV1` を読むことだけである。
Photos の D1 には一切アクセスしないので、Film Gallery は別アカウントのまま維持できる。

### 一時共有ギャラリー

限定公開（Unlisted）の共有は、`temporary-share` 種別の Publication Target として実装する。
`slug` は推測できない乱数（128 ビット）にし、URL を知る人だけが閲覧できるようにする。
閲覧用の Worker は Film Gallery と同じく公開先のアカウントに置き、Manifest を読んで表示する。
期限（`expiresAt`）を過ぎたら、`PhotoJobsDO` の alarm が取り下げを実行し、閲覧用の Worker も `expiresAt` を見て表示を止める。

この経路を基本にするのは、Cloudflare OS 本体に外部から入れる入口を作らずに済み、Access を使う構成でもそのまま動くからである。

### 直接共有リンク（Access を使わない構成のみ）

Cloudflare Access を使わない構成では、Photos Worker が `/share/:token` で直接配る共有リンクも使える。
コピーが不要なので即時に共有でき、取り消しも `share_links.revoked_at` を立てるだけで済む。

この機能は secret `PHOTOS_DIRECT_SHARE` が設定されているときだけ有効になり、`scripts/deploy.sh` は Access を検出しなかったときだけこれを設定する。
Access を使う構成では `/share/*` も Access に遮られて外部の人は開けないため、UI にこの選択肢を出さない（`/share-links/capability` が false を返す）。

`/share/*` は router からも認証なしで届くため、Photos Worker は次を守る。

- トークンは 128 ビットの乱数とし、D1 には SHA-256 だけを保存する。
- 応答は `ExposurePolicy` を適用した値だけにし、内部の `PhotoId` や `storage_key` を出さない。
- 原本は `downloadAllowed` とアルバムの `downloadOverride` を `resolveDownloadAllowed` で解決して許可されたときだけ配る。
- 失敗の応答は、トークンが存在しない場合も期限切れの場合も同じ 404 にする。

## フロントエンド

左ペインの各項目は、`/photos/search` に渡す `SearchQuery` の違いとして実装する。

| 項目 | ルート | 条件 |
| --- | --- | --- |
| Library | `/photos` | なし |
| Recent | `/photos/recent` | `sort: "created_desc"` |
| Favorites | `/photos/favorites` | `favorite: true` |
| Albums | `/photos/albums`、`/photos/albums/$id` | `albumId` |
| Tags | `/photos/tags/$id` | `tagIds: [id]` |
| Photographers | `/photos/photographers/$id` | `photographerIds: [id]` |
| Public、Unlisted、Private | `/photos/visibility/$v` | `visibility: [v]` |
| Imports | `/photos/imports` | ジョブ一覧 |
| Downloads | `/photos/downloads` | ブラウザ内のダウンロード履歴（サーバーには保存しない） |
| Storage | `/photos/storage`、`/photos/storage/$id` | 接続の状態、D1 使用量、`connectionId` での絞り込み |

グリッドは可視範囲だけを描画する仮想スクロールにし、サムネイル URL の期限切れ（既定 5 分）はページ単位の再取得で扱う。
Inspector と一括編集は、選択が一件なら `PATCH /photos/:id`、複数なら `POST /photos/bulk` を呼ぶ。
Photos の項目は、Inbox と同じく管理者にだけ表示する。

## フェーズと PR の分け方

構想のフェーズをそのまま使い、各フェーズを次の PR に分ける。
既存ファイルへの変更（前述の九か所）は、どのフェーズでも独立したコミットにする。

| フェーズ | PR | 主な内容 | 既存ファイルへの変更 |
| --- | --- | --- | --- |
| 0 | 準備 A | `manifest-lib.ts` の `d1_databases` 対応と `photos` 種別。`MANIFEST_VERSION` は 2 のまま据え置き、D1 か `photos` を含むリリースは版が 3 未満なら生成に失敗させる | `scripts/release/*` |
| 0 | 準備 B | 認証の共通関数と `/api/photos-auth` | `workshop-backend` の二ファイル |
| 1 Core | 1 | `packages/photos` の雛形、D1 スキーマと自己適用、`PHOTOS_CREDENTIAL_KEY` の検査、写真、タグ、アルバム、撮影者の API、検索、使用量の記録。`MANIFEST_VERSION` を 3 に上げ、golden を更新する（デプロイサービスが `$D1_<BINDING>_ID` に対応してから） | `scripts/deploy.sh`、`scripts/release/*` |
| 1 Core | 2 | Library、Inspector、左ペイン、検索バー、Storage 画面の使用量表示 | router、Sidebar、routes、i18n |
| 2 R2 | 3 | `r2-binding`、`r2-s3`、秘密情報の暗号化、Upload、Download、`/blob/:token`、ブラウザでの派生画像生成 | なし |
| 3 NAS | 4 | `photo-storage-agent`、`NasAgentDO`、ペアリングと Agent 認証、NAS Provider、Worker による中継 | なし |
| 3 NAS | 5 | Import 画面、監視フォルダ、コピーと移動、オフライン表示 | なし |
| 4 Management | 6 | RAW+JPEG の組、重複の表示、一括編集、詳細検索 | なし |
| 5 Sharing | 7 | 公開状態、`ExposurePolicy`、一時共有ギャラリー、直接共有リンク、ダウンロード制御 | router（`/share/*`）、`scripts/deploy.sh` |
| 6 Film Gallery | 8 | Film Gallery の Publication Target、Manifest、別アカウント R2 への公開 | なし |
| 7 Advanced | 以降 | 知覚ハッシュ、複数の複製、時間帯指定のハッシュ照合、追加の Provider | 未定 |

## 決定の記録

設計の途中で選択肢を比べて決めた事項と、その理由を残す。

- **メタデータは D1、処理と状態は DO の SQLite**：D1 はこのリポジトリで初めて使うため、マニフェストの対応が必要になる。それでも、NAS がオフラインでも読める検索用の置き場と、長時間続く処理の置き場を分けることを優先した。
- **限定公開リンクは一時共有ギャラリーを基本とし、Access なしの構成では直接リンクも使う**：Access を使う構成では、Cloudflare OS 本体が発行したリンクを外部の人は開けない。公開先へのコピーで共有すれば本体に入口を作らずに済み、Access を使わない構成では即時に共有できる直接リンクも選べる。
- **NAS 原本は Worker が中継する**：ブラウザが Tunnel へ直接アクセスする案は最速だが、`/download/*` だけ Access を外す設定を誤ると NAS の API 全体が露出する。R2 へ一時コピーする案は初回の待ち時間と容量を要する。中継なら追加設定なしで NAS をブラウザから隠せる。
- **Agent への指示は WebSocket、データは Tunnel**：HDD スリープを使う前提で比べた。keepalive がプロトコルの ping だけで済み、Agent のコードが待機中に動かないこと、切断を即座に検出できることを取った。データまで WebSocket に流す案は、cloudflared が不要になる代わりに、大きなファイルが DO のメモリを通るため採らなかった。
- **暗号鍵は Worker secret 必須**：DO で自動生成する案は入力の手間がないが、Cloudflare が推奨する secret の形を取った。自前デプロイでは `deploy.sh` が生成するので、手間が増えるのはウィザードだけである。
- **ライブラリはデプロイ全体で一つ**：個人か少人数の運用を前提とし、Inbox と同じ権限モデルにそろえた。複数のライブラリや役割（編集者、閲覧者）が必要になった場合は、全テーブルに `library_id` を加える移行が必要になる。
- **D1 は単一のまま監視する**：一枚あたり約 2KB の見積もりで上限はおよそ 500 万枚になり、個人か少人数の写真管理では届く可能性が低い。分割は、監視で上限に近づいたことが分かった時点で設計する。
