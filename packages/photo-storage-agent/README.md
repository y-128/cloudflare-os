# Photo Storage Agent

NAS 上で動き、Cloudflare OS の Photos に NAS の写真を取り込ませるエージェントです。
設計は `plans/photos.md` の「NAS Storage Agent」の節にあります。

エージェントは次の二つの経路で Cloudflare OS とつながります。

- **制御用 WebSocket**：エージェントから Cloudflare OS へ張る常時接続です。取り込みの指示（走査、プレビュー生成、複製、削除）を受け、結果を返します。
- **読み出し専用 HTTP**：Cloudflare Tunnel（`cloudflared`）越しに、Photos Worker が元画像を読みに来ます。すべての要求にペアリング時に共有した鍵の署名が必要で、書き込みや削除の手段はありません。

ブラウザが NAS に直接アクセスすることはありません。
原本のダウンロードは Photos Worker が中継します。

## 準備

1. Cloudflare Zero Trust で Tunnel を作り、公開ホスト名（例：`nas-agent.example.com`）を `http://photo-storage-agent:8080` に向けます。
2. その公開ホスト名に Cloudflare Access のアプリケーションを作り、Service Auth のポリシーで service token を一つ許可します。
3. Cloudflare OS の「写真 → ストレージ → ストレージを追加 → NAS」で、Tunnel のホスト名と 2 の service token を登録します。表示される **接続 ID** と **ペアリングコード** を控えます（ペアリングコードは 1 時間有効で、一度しか使えません）。
4. Cloudflare OS 自体を Cloudflare Access で保護している場合は、その Access アプリケーションにも Service Auth のポリシーを追加し、エージェント用の service token を発行します（エージェントの WebSocket が Access を通るため）。

## 設定

`/config/agent.json` を作ります。

```json
{
  "serverUrl": "https://os.example.com",
  "connectionId": "stc_…",
  "libraryRoot": "/data",
  "incomingFolder": "Incoming",
  "access": { "clientId": "….access", "clientSecret": "…" }
}
```

| 項目 | 既定値 | 内容 |
| --- | --- | --- |
| `serverUrl` | 必須 | Cloudflare OS の公開 URL |
| `connectionId` | 必須 | 手順 3 の接続 ID |
| `libraryRoot` | `/data` | 写真ライブラリのマウント先。Photos が扱うパスはすべてここからの相対パスです |
| `incomingFolder` | `Incoming` | 監視するフォルダ。`null` で監視しません |
| `listenHost`、`listenPort` | `0.0.0.0`、`8080` | cloudflared の転送先 |
| `stateFile` | `/config/state.json` | ペアリングで作る鍵の保存先 |
| `access` | なし | 手順 4 の service token（Cloudflare OS が Access の内側にある場合） |
| `rescanIncomingOnStart` | `true` | 起動時に監視フォルダ内の既存ファイルを一度だけ通知します（停止中に追加されたファイルのため） |

## ペアリングと起動

```sh
docker build -f packages/photo-storage-agent/Dockerfile -t photo-storage-agent .   # リポジトリのルートで
docker compose run --rm photo-storage-agent pair <ペアリングコード>
docker compose up -d
```

`pair` は Ed25519 の鍵対を作り、公開鍵を Cloudflare OS に登録して `/config/state.json` に保存します。
秘密鍵は NAS の外に出ません。
ペアリングし直すと、古い鍵のエージェントは接続できなくなります。

## HDD スリープについて

エージェントは待機中にディスクへ触れないように作っています。

- 監視フォルダは inotify（`fs.watch`）で監視し、定期的に読み直しません。
- ログは標準出力だけに出します。`docker-compose.example.yml` は既定でログを捨てます。
- 設定ファイルは起動時に一度だけ読みます。
- Cloudflare OS との keepalive は WebSocket の ping だけで、ディスクには触れません。

ただし、NAS の機種によっては Docker 自体（Synology の Container Manager など）の動作で HDD がスリープしないことがあります。
エージェント側でできるのは上の対策までで、スリープを保証するものではありません。

## 開発

```sh
pnpm --filter @gadgets/photo-storage-agent test:run
```

Node 22.18 以降で、TypeScript をそのまま実行します（ビルド工程はありません）。
