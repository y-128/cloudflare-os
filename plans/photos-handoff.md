# 引き継ぎ: Cloudflare OS Photos（Phase 4 完了時点）

この文書は、Photos の実装を途中から引き継ぐ人のためのものである。
設計の全体は `plans/photos.md` にあり、この文書は「いまどこまでできていて、どう動かし、次に何をするか」だけを扱う。

- ブランチ：`claude/cloudflare-os-photos-plan-vwnt6m`（push 済み。PR は未作成）
- 最終更新：2026-09-27

## 現在地

Phase 0 から Phase 4 までを実装し、単体テストとブラウザでの動作確認を終えている。
Phase 5（共有）から先は未着手である。

| フェーズ | 状況 | 主な内容 |
| --- | --- | --- |
| 0 準備 | 完了 | リリースマニフェストの D1 対応（`MANIFEST_VERSION` 3）、`/api/photos-auth` |
| 1 Core | 完了 | `packages/photos` Worker、D1 スキーマの自己適用、写真・タグ・アルバム・撮影者の API、検索、使用量の記録。Library、Inspector、一括編集の画面 |
| 2 R2 | 完了 | `r2-binding` と `r2-s3`、秘密情報の暗号化、ブラウザからのアップロード（派生画像はブラウザで生成）、ダウンロード |
| 3 NAS | 完了 | `photo-storage-agent`、ペアリング、`NasAgentDO` の WebSocket、参照・コピー・移動の取り込み、監視フォルダの自動取り込み、Import 画面 |
| 4 Management | 完了 | RAW+JPEG の自動の組と手動の結合・分割、重複の表示、詳細検索（`dup:yes` を追加） |
| 5 Sharing | 未着手 | `ExposurePolicy`、一時共有ギャラリー、直接共有リンク（`/share/*`）、ダウンロード制御 |
| 6 Film Gallery | 未着手 | Publication Target と Manifest、別アカウント R2 への公開 |
| 7 Advanced | 未着手 | 知覚ハッシュ、複数の複製、時間帯指定のハッシュ照合、追加の Provider |

## コードの地図

| 場所 | 内容 |
| --- | --- |
| `packages/photos/shared/` | フロントエンド、Worker、Agent が共有する型と純粋関数（`api-types.ts`、`agent-protocol.ts`、`exif.ts`、`search-query.ts`、`ids.ts`、`visibility.ts`） |
| `packages/photos/workers/app.ts` | Hono のエントリ。管理者認証の内側に通常の API、外側に `/blob`（署名付き読み出し）、`/upload`（署名付き書き込み）、`/agent`（Agent の署名で認可）を置く |
| `packages/photos/workers/db/` | D1 へのアクセス。`migrations/0001-init.ts` がスキーマ、`pairing.ts` が RAW+JPEG の組、重複、結合と分割 |
| `packages/photos/workers/storage/` | Storage Provider（`r2-binding.ts`、`r2-s3.ts`、`nas.ts`）、grant の署名（`grants.ts`）、秘密情報の暗号化（`credentials.ts`） |
| `packages/photos/workers/durableObject/` | `PhotoJobsDO`（アップロードのセッションと取り込みジョブ）、`NasAgentDO`（Agent の接続とコマンド列）、`SchemaMigratorDO` |
| `packages/photos/workers/jobs/imports.ts` | NAS 取り込みの状態機械（走査 → 登録 → 派生画像 → 複製 → 移動元の削除） |
| `packages/photo-storage-agent/` | NAS で動く Node の Agent。README に設置手順がある |
| `packages/workshop-frontend/src/features/photos/` | 画面の部品。`pages/photos/PhotosPage.tsx` が全体を組み立てる |

## 既存ファイルへの変更

ローカルだけにあるブランチと衝突しうるのは、新規ディレクトリの外にある次のファイルだけである。
それぞれ独立したコミットに分けてあるので、衝突したときは該当コミットだけを見ればよい。

- リリースとデプロイ：`scripts/release/manifest-lib.ts`（とテスト、golden、fixture）、`scripts/deploy.sh`、`deploy.config.sample.json`、`DEPLOY.md`、`scripts/preview/{preview,staging-config}.ts`
- 開発サーバー：`scripts/dev-server-config.ts`、`scripts/run-dev-server.ts`
- 認証：`packages/workshop-backend/src/{admin-service-auth.ts（新規）,inbox-auth.ts,server.ts}`
- ルーティング：`packages/router/src/index.ts`、`packages/router/wrangler.jsonc`
- フロントエンド：`src/routes/photos.tsx`、`src/routeTree.gen.ts`、`src/components/AppShell/Sidebar.tsx`、`package.json`（`exifr`）
- 文言：`packages/i18n/src/locales/{ja,en}.ts`（`workshop-frontend.Photos.*` を末尾に追加）
- `pnpm-lock.yaml`（新しい importer の追加のみ。後述の注意を参照）

## 動かし方

### テスト

```sh
pnpm --filter @gadgets/photos test:run              # Worker（workerd 上、64 件）
pnpm --filter @gadgets/photo-storage-agent test:run # Agent（node --test、9 件）
cd packages/workshop-frontend && pnpm exec vitest run src/features/photos src/pages/photos
pnpm lint                                           # push 前に必ず
```


### ローカルで画面を確認する

1. `packages/workshop-frontend` で `pnpm exec vite build` を実行する。開発ルーターは `dist/` を配信するので、画面を変えたら再ビルドが必要である。
2. `pnpm dev-server` で起動する。ただし `packages/workshop-backend/wrangler.dev.jsonc`（gitignore 対象の生成物）に `ai` バインディングがあると、Cloudflare へのログインを求められて止まる。この環境では `ai` を消し、生成された引数で `pnpm exec wrangler dev -c wrangler.dev.jsonc -c packages/workshop-backend/wrangler.dev.jsonc -c packages/photos/wrangler.dev.jsonc …` を直接実行した。
3. `dist/` を作り直したあとは wrangler dev を再起動する。再起動しないと古いアセット一覧のまま新しい JS が 404（HTML が返る）になる。
4. `http://localhost:8787/photos` を開く。初回はオンボーディングを「建ててみましょう」まで進める必要がある。

### NAS の取り込みを手元で試す

1. 画面の「ストレージ → ストレージを追加 → NAS」で接続を作り、接続 ID とペアリングコードを控える。Tunnel の URL は https 必須なので、手元では登録後に D1 の `storage_connections.config_json` の `tunnelUrl` を `http://localhost:8099` に書き換えた。
2. `packages/photo-storage-agent` で、次のような設定ファイルを作る。

   ```json
   { "serverUrl": "http://localhost:8787", "connectionId": "stc_…", "libraryRoot": "/path/to/lib",
     "incomingFolder": "Incoming", "listenHost": "127.0.0.1", "listenPort": 8099,
     "stateFile": "/path/to/state.json", "rescanIncomingOnStart": false }
   ```

3. `PHOTO_AGENT_CONFIG=<設定ファイル> node src/main.ts pair <コード>`、続けて `… node src/main.ts run`。Node 22.18 以上が必要である（TypeScript をそのまま実行する）。

## 実装上の注意（ハマりどころ）

- **Durable Object の RPC はエラーの型を落とす**：`HttpError` を DO の中で投げると、呼び出し側には `Error` しか届かない。ステータスはメッセージに埋め込んであり、`HttpError.revive()` が `app.ts` の `onError` で復元する。新しい DO メソッドでも `HttpError` をそのまま投げてよい。
- **Agent への指示は `dispatch()` を通す**：Agent の応答は送信の完了より先に届くことがあるので、送信と項目の状態の記録を `blockConcurrencyWhile` の中で行う（`workers/jobs/imports.ts`）。その中で例外を投げると DO 全体がリセットされるため、例外は外へ持ち出してから投げ直している。
- **D1 の BLOB は `number[]` で返る**：`new Uint8Array(row.x)` で戻す。
- **`exifr` は `exifr/dist/full.esm.mjs` から読み込む**：パッケージの型定義が Node の型を引き込み、ほかのパッケージの型検査を壊すため。型はローカルの `exifr.d.ts` で補っている。
- **ロックファイル**：`pnpm install` をそのまま実行すると、`agents` の peer 解決や zod の版が変わり、無関係なパッケージの型検査が壊れることがあった。依存を足すときは差分を確認し、新しい importer の追加以外の変更は戻す。確認は `pnpm install --frozen-lockfile`。
- **Agent は Node の型除去で動く**：コンストラクタの引数プロパティや `enum` は使えない（`erasableSyntaxOnly`）。import には拡張子 `.ts` を付ける。
- **テストは固定時間の待機に頼らない**：WebSocket 越しの処理は `agent.awaitCommands()` と `vi.waitFor()` で結果を待つ。`settle()` だけで待つと負荷によって失敗する。
- **シードの偽 NAS**：開発用の初期データにある `stc_01J0000000000000000000NAS0` は秘密情報を持たないため、フォルダ一覧が 500 になる。シードだけの問題である。

## 既知の課題と未実装

- `GET /photos/:id/exif/raw`：EXIF 原文を保存する処理がなく未実装。
- `DELETE /photos/:id?purge=1`：ストレージ上のファイルの削除ジョブは未実装。ゴミ箱への移動（論理削除）だけがある。
- ブラウザから RAW と JPEG を同時にアップロードすると、完了処理が並行するため組にならないことがある。その場合は Inspector の候補から手動で組にできる。
- 組を「分ける」と、結合で持ち込まれた派生画像がない限り、分けた側の Photo にはプレビューがない。派生画像を作り直す手段はまだない。
- 組になった RAW の取り込み項目を「再試行」すると、派生画像を作り直して表紙が RAW の埋め込みプレビューに替わる。
- 監視フォルダの自動取り込みのジョブは、その日のあいだ「取り込み中」のまま開いている（仕様）。

## 次にやること

`plans/photos.md` の「フェーズと PR の分け方」に沿って Phase 5 から進める。

1. **Phase 5 Sharing**：`ExposurePolicy` と `resolveDownloadAllowed`（`shared/visibility.ts` に型と関数はある）を API に通し、一時共有ギャラリーの Publication Target と、Access を使わない構成だけの直接共有リンク（`PHOTOS_DIRECT_SHARE`、`/share/*`）を作る。router の `run_worker_first` に `/share/*` を足すのは既存ファイルの変更なので、独立したコミットにする。
2. **Phase 6 Film Gallery**：Publication Manifest の書き出しと、別アカウント R2（`r2-s3`）への公開。
3. **Phase 7 Advanced**：知覚ハッシュ（`photos.phash` の列は用意済み）など。

作業を始める前に、`plans/photos.md` の「既存コードへの依存と前提」の確認手順で、ローカル専用ブランチとの差分を確かめること。
