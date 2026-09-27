#!/usr/bin/env bash
# cfos を1コマンドでデプロイし、secret も設定する。
#
#   ./scripts/deploy.sh              デプロイして secret を設定する
#   ./scripts/deploy.sh --dry-run    アップロードせず、何をするかだけ表示する
#   ./scripts/deploy.sh --secrets    デプロイを飛ばして secret の設定だけ行う
#   ./scripts/deploy.sh --yes        確認を省略する
#
# 値は deploy.config.json から読みます。deploy.config.sample.json をコピーして
# 作ってください。値は表示もログ出力もしません。
#
# Worker の順序は router を最後にします。router は他の Worker をサービスバインディングで
# 参照するため、先にデプロイすると参照先を見失います。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/deploy.config.json"
# packages/ 配下の「ディレクトリ名」。パッケージ名とは一致しないものがあるので注意
# (packages/gatekeeper-email のパッケージ名は @gadgets/email-gatekeeper で前後が逆)。
# 順序は router を最後にする。router は他をサービスバインディングで参照するため。
WORKERS=(workshop-backend inbox photos gatekeeper-email router)
# Node 24 でないと gatekeeper-google のテストが URLPattern 未定義で落ちる。
REQUIRED_NODE_MAJOR=24
# Access のログインリダイレクトを読み取るときの待ち時間。
DETECT_TIMEOUT_SECONDS=15

DRY_RUN=""
SECRETS_ONLY=""
ASSUME_YES=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --secrets) SECRETS_ONLY=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --help | -h) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不明な引数: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "[deploy] $*" >&2; exit 1; }
step() { echo; echo "[deploy] ==== $* ===="; }

# --- 事前確認 -----------------------------------------------------------------

step "事前確認"

for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
  [ -x "$candidate" ] || continue
  major="$("$candidate" -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null)"
  if [ "$major" = "$REQUIRED_NODE_MAJOR" ]; then
    PATH="$(dirname "$candidate"):$PATH"
    export PATH
    break
  fi
done
command -v node >/dev/null 2>&1 || die "node が見つかりません"
command -v pnpm >/dev/null 2>&1 || die "pnpm が見つかりません。corepack enable を試してください"
echo "[deploy] node $(node -v)"

[ -f "$CONFIG" ] || die "$CONFIG がありません。deploy.config.sample.json をコピーして作ってください"

# ここから下で config を読む。値は変数に入れるだけで表示しない。
read_config() {
  node -e '
    const fs = require("node:fs");
    let config;
    try {
      config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch (err) {
      console.error("[deploy] deploy.config.json を読めません: " + err.message);
      process.exit(1);
    }
    // 値そのものは出さず、シェルへ渡すためだけに base64 で1行にまとめる。
    const wanted = process.argv.slice(2);
    const out = {};
    for (const key of wanted) {
      const value = config[key];
      if (typeof value === "string" && value.length > 0) out[key] = value;
    }
    process.stdout.write(Buffer.from(JSON.stringify(out)).toString("base64"));
  ' "$CONFIG" "$@"
}

CONFIG_B64="$(read_config CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID DOMAINS EMAIL_ADDRESSES \
  DISCORD_WEBHOOK_URL ADMINS CFOS_PUBLIC_URL MAIL_ROUTING_WORKER ACCESS_TEAM_URL ACCESS_AUD)" \
  || die "設定を読めませんでした"

missing="$(node -e '
  const config = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
  const required = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "ADMINS"];
  process.stdout.write(required.filter(key => !config[key]).join(" "));
' "$CONFIG_B64")"
[ -z "$missing" ] || die "deploy.config.json に必須項目がありません: $missing"

# 受信ドメインは secret ではなく wrangler.jsonc の vars で持つ。同名の secret を作ろうと
# すると Cloudflare 側が binding 名の衝突として拒否する (code 10053)。ここでは値が入って
# いるかだけを見る。
node -e '
  const fs = require("node:fs");
  const source = fs.readFileSync(process.argv[1], "utf8");
  // コメント付き JSON なので、行コメントとブロックコメントを落としてから読む。
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  let config;
  try {
    config = JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    process.exit(0);  // 解析できなければ黙って通す。デプロイ時に wrangler が検証する。
  }
  const domains = config.vars && config.vars.DOMAINS;
  const list = Array.isArray(domains) ? domains : typeof domains === "string" ? [domains] : [];
  const unset = list.length === 0 || list.some(value => /^example\.(com|org)$/.test(value));
  if (unset) {
    console.error("[deploy] packages/inbox/wrangler.jsonc の vars.DOMAINS に受信ドメインを設定してください");
    console.error("[deploy] 例: \"DOMAINS\": [\"example.com\"]");
    process.exit(1);
  }
' "$ROOT/packages/inbox/wrangler.jsonc" || exit 1

# --- 確認 ---------------------------------------------------------------------

if [ -z "$ASSUME_YES" ]; then
  echo
  if [ -n "$DRY_RUN" ]; then
    echo "[deploy] --dry-run です。アップロードも secret 設定も行いません。"
  else
    echo "以下を本番環境に反映します。"
    [ -z "$SECRETS_ONLY" ] && printf '  デプロイ: %s\n' "${WORKERS[*]}"
    echo "  secret : workshop-backend、inbox、photos に設定"
  fi
  printf "続けますか? [y/N] "
  read -r reply
  case "$reply" in y | Y | yes | YES) ;; *) echo "中止しました"; exit 1 ;; esac
fi

# --- ビルドとデプロイ ----------------------------------------------------------

# ディレクトリ名からパッケージ名を引く。両者は一致しないことがあるので必ずここを通す。
# 存在しないディレクトリを渡した場合は、空文字を返して後続を壊すのではなく即座に止める。
package_name() {
  local manifest="$ROOT/packages/$1/package.json"
  [ -f "$manifest" ] || die "packages/$1 がありません。WORKERS にはディレクトリ名を書きます"
  node -e '
    const name = require(process.argv[1]).name;
    if (!name) { console.error("name が未定義: " + process.argv[1]); process.exit(1); }
    process.stdout.write(name);
  ' "$manifest" || die "packages/$1/package.json からパッケージ名を読めませんでした"
}

deploy_log="$(mktemp)"
trap 'rm -f "$deploy_log"' EXIT

PUBLIC_URL="$(node -e '
  const config = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
  process.stdout.write(config.CFOS_PUBLIC_URL || "");
' "$CONFIG_B64")"
ACCESS_TEAM_URL=""
ACCESS_AUD=""

# 公開 URL の保護されたパスを叩き、Access のログイン画面へ 302 するかを見る。
# リダイレクト先にチーム URL と Application Audience が含まれる。
detect_access() {
  [ -n "$PUBLIC_URL" ] || return 0
  local location
  location="$(curl -s -D - -o /dev/null --max-time "$DETECT_TIMEOUT_SECONDS" "$PUBLIC_URL/api" \
    | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')"
  [ -n "$location" ] || return 0
  ACCESS_TEAM_URL="$(printf '%s' "$location" | sed -nE 's#^(https://[^/]+)/cdn-cgi/access/login/.*#\1#p')"
  ACCESS_AUD="$(printf '%s' "$location" | sed -nE 's#.*[?&]kid=([0-9a-f]{64}).*#\1#p')"
}

# Access の有無でフロントエンドのビルド結果が変わる。VITE_CF_ACCESS_MODE はバンドルに
# 埋め込まれる (packages/workshop-frontend/src/useAuth.ts)。true でないとログイン画面が
# 出てしまい、backend は Access モードなのでパスワード認証を拒否する、という噛み合わせに
# なるため、ビルド前に判定しておく必要がある。
run_build() {
  if [ -n "$ACCESS_TEAM_URL" ]; then
    echo "[deploy] Access モードのフロントエンドをビルドします"
    ( cd "$ROOT" && VITE_CF_ACCESS_MODE=true pnpm build ) || die "ビルドに失敗しました"
  else
    ( cd "$ROOT" && pnpm build ) || die "ビルドに失敗しました"
  fi
}

if [ -z "$SECRETS_ONLY" ]; then
  step "Cloudflare Access の判定"
  detect_access
  if [ -n "$ACCESS_TEAM_URL" ]; then
    echo "[deploy] Access: 有効 ($ACCESS_TEAM_URL)"
  elif [ -n "$PUBLIC_URL" ]; then
    echo "[deploy] Access: 無効"
  else
    echo "[deploy] 公開 URL が未知のため、デプロイ後に判定します"
  fi

  step "ビルド"
  run_build

  step "デプロイ"
  for worker in "${WORKERS[@]}"; do
    name="$(package_name "$worker")"
    echo "[deploy] --- $worker ($name) ---"
    if [ -n "$DRY_RUN" ]; then
      ( cd "$ROOT" && pnpm --filter "$name" exec wrangler deploy --dry-run ) \
        || die "$worker の dry-run に失敗しました"
    else
      ( cd "$ROOT" && pnpm --filter "$name" exec wrangler deploy ) 2>&1 | tee -a "$deploy_log"
      [ "${PIPESTATUS[0]}" -eq 0 ] || die "$worker のデプロイに失敗しました。以降は実行していません"
    fi
  done
fi

# --- 公開 URL と Access の検出 --------------------------------------------------

step "公開 URL と Access の確定"

if [ -z "$PUBLIC_URL" ] && [ -s "$deploy_log" ]; then
  # wrangler はデプロイ結果に公開 URL を出す。router のものを拾う。
  PUBLIC_URL="$(grep -oE 'https://router\.[A-Za-z0-9.-]+\.workers\.dev' "$deploy_log" | tail -1)"
  # 初回デプロイでは、ここで初めて Access の有無が分かる。Access モードのフロントエンドは
  # ビルドし直さないと反映されないため、必要ならもう一度だけビルドして router を出し直す。
  if [ -n "$PUBLIC_URL" ] && [ -z "$SECRETS_ONLY" ]; then
    detect_access
    if [ -n "$ACCESS_TEAM_URL" ]; then
      echo "[deploy] Access を検出しました。フロントエンドを Access モードで作り直します"
      if [ -z "$DRY_RUN" ]; then
        run_build
        ( cd "$ROOT" && pnpm --filter "$(package_name router)" exec wrangler deploy ) \
          || die "router の再デプロイに失敗しました"
      fi
    fi
  fi
fi

if [ -z "$PUBLIC_URL" ]; then
  echo "[deploy] 公開 URL を検出できませんでした。"
  echo "[deploy] deploy.config.json の CFOS_PUBLIC_URL に設定するか、独自ドメインを割り当ててください。"
else
  echo "[deploy] 公開 URL: $PUBLIC_URL"
fi

# 明示指定があればそれを優先する。検出できなかった場合の逃げ道。
for key in ACCESS_TEAM_URL ACCESS_AUD; do
  configured="$(node -e '
    const config = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
    process.stdout.write(config[process.argv[2]] || "");
  ' "$CONFIG_B64" "$key")"
  [ -n "$configured" ] && eval "$key=\$configured"
done

[ -n "$SECRETS_ONLY" ] && detect_access

if [ -n "$ACCESS_TEAM_URL" ] && [ -n "$ACCESS_AUD" ]; then
  echo "[deploy] Cloudflare Access: 有効 ($ACCESS_TEAM_URL)"
else
  echo "[deploy] Cloudflare Access: 無効。cfos 自身のログインで保護されます。"
  ACCESS_TEAM_URL=""
  ACCESS_AUD=""
fi

# --- secret の設定 -------------------------------------------------------------

step "secret の設定"

# 対象 Worker 向けの secret を JSON にまとめて stdin から wrangler へ渡す。
# 値をコマンドライン引数に置かないので、プロセス一覧にも履歴にも残らない。
# Worker に設定済みの secret 名を1行1件で出す。取得できなければ何も出さない。
existing_secrets() {
  ( cd "$ROOT" && pnpm --filter "$(package_name "$1")" exec wrangler secret list --format json 2>/dev/null ) \
    | node -e '
      let input = "";
      process.stdin.on("data", chunk => { input += chunk; });
      process.stdin.on("end", () => {
        try { for (const { name } of JSON.parse(input)) console.log(name); } catch {}
      });
    '
}

put_secrets() {
  local worker="$1" name payload count existing=""
  name="$(package_name "$worker")"
  [ "$worker" = "photos" ] && existing="$(existing_secrets photos)"
  payload="$(node -e '
    const config = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
    const [target, publicUrl, accessTeamUrl, accessAud, routingWorker, existing] = process.argv.slice(2);
    const secrets = {};
    /** 空でない値だけを積む。空の項目は設定せず、既存の値を残す。 */
    const set = (key, value) => { if (value) secrets[key] = value; };
    if (target === "workshop-backend") {
      set("ADMINS", config.ADMINS);
      set("CF_ACCESS_AUD", accessAud);
      set("CF_ACCESS_ISS", accessTeamUrl);
    } else if (target === "photos") {
      // 暗号鍵は一度設定したら上書きしない。変えると保存済みの接続情報を復号できなくなる。
      // deploy.config.json に値がなければ、初回だけここで生成する。
      if (!existing.split("\n").includes("PHOTOS_CREDENTIAL_KEY")) {
        set("PHOTOS_CREDENTIAL_KEY",
          config.PHOTOS_CREDENTIAL_KEY || require("node:crypto").randomBytes(32).toString("base64"));
      }
      // Access の内側では外部の人が /share/* を開けないので、直接共有リンクは Access なしのときだけ。
      if (!accessAud) set("PHOTOS_DIRECT_SHARE", "1");
    } else {
      // DOMAINS と EMAIL_ADDRESSES はここで設定しない。packages/inbox/wrangler.jsonc の
      // vars として宣言済みで、同名の secret は作れない (Cloudflare API code 10053)。
      // 秘密情報でもないので、vars のままにしておくのが正しい。
      set("CLOUDFLARE_API_TOKEN", config.CLOUDFLARE_API_TOKEN);
      set("CLOUDFLARE_ACCOUNT_ID", config.CLOUDFLARE_ACCOUNT_ID);
      set("DISCORD_WEBHOOK_URL", config.DISCORD_WEBHOOK_URL);
      set("CFOS_PUBLIC_URL", publicUrl);
      set("MAIL_ROUTING_WORKER", routingWorker);
      set("POLICY_AUD", accessAud);
      set("TEAM_DOMAIN", accessTeamUrl);
    }
    process.stdout.write(JSON.stringify(secrets));
  ' "$CONFIG_B64" "$worker" "$PUBLIC_URL" "$ACCESS_TEAM_URL" "$ACCESS_AUD" \
      "$(node -e '
        const config = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
        process.stdout.write(config.MAIL_ROUTING_WORKER || "router");
      ' "$CONFIG_B64")" "$existing")"

  count="$(printf '%s' "$payload" | node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(String(Object.keys(JSON.parse(input)).length)));
  ')"
  if [ "$count" = "0" ]; then
    echo "[deploy] $worker: 設定する secret がありません"
    return 0
  fi
  if [ -n "$DRY_RUN" ]; then
    echo "[deploy] $worker: $count 件を設定します (--dry-run のため実行しません)"
    printf '%s' "$payload" | node -e '
      let input = "";
      process.stdin.on("data", chunk => { input += chunk; });
      process.stdin.on("end", () => {
        for (const key of Object.keys(JSON.parse(input))) console.log("           " + key);
      });
    '
    return 0
  fi
  echo "[deploy] $worker: $count 件を設定します"
  printf '%s' "$payload" | ( cd "$ROOT" && pnpm --filter "$name" exec wrangler secret bulk ) \
    || die "$worker の secret 設定に失敗しました"
}

put_secrets workshop-backend
put_secrets inbox
put_secrets photos

# Access を後から有効にした場合、以前に設定した直接共有リンクの許可を取り消す。
if [ -n "$ACCESS_AUD" ] && existing_secrets photos | grep -x PHOTOS_DIRECT_SHARE >/dev/null; then
  if [ -n "$DRY_RUN" ]; then
    echo "[deploy] photos: PHOTOS_DIRECT_SHARE を削除します (--dry-run のため実行しません)"
  else
    echo "[deploy] photos: Access が有効なので PHOTOS_DIRECT_SHARE を削除します"
    ( cd "$ROOT" && printf 'y\n' | pnpm --filter "$(package_name photos)" exec wrangler secret delete PHOTOS_DIRECT_SHARE ) \
      || die "photos の PHOTOS_DIRECT_SHARE を削除できませんでした"
  fi
fi

# --- 完了 ---------------------------------------------------------------------

step "完了"
if [ -n "$DRY_RUN" ]; then
  echo "[deploy] --dry-run のため、何も変更していません。"
else
  echo "[deploy] デプロイと secret 設定が終わりました。"
  [ -n "$PUBLIC_URL" ] && echo "[deploy] $PUBLIC_URL を開いて確認してください。"
  echo "[deploy] 次は DEPLOY.md の手順7(ドメインのオンボード)です。"
fi
