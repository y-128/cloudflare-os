import { useState, FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { RpcStub } from "capnweb";
import { PublicApi } from "@gadgets/workshop-shared/api";
import { Hexagon } from "@phosphor-icons/react";
import { Input, Button, Banner, Loader } from "@cloudflare/kumo";
import { hashPassword } from "./passwordHash";
import { useServerConfig, useServerConfigError, useSiteName } from "./ServerConfigContext";
import { useDocumentTitle } from "./useDocumentTitle";
import OAuthButtons from "./components/auth/OAuthButtons";
import SiteLogo from "./components/SiteLogo";
import { useConnectionLost } from "./RpcContext";

interface SignupPageProps {
  rpcStub: RpcStub<PublicApi>;
}

export default function SignupPage({ rpcStub }: SignupPageProps) {
  const serverConfig = useServerConfig();
  const serverConfigError = useServerConfigError();
  const siteName = useSiteName();
  const connectionLost = useConnectionLost();
  useDocumentTitle("アカウントを作成する");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usernameError =
    username && !/^[a-z0-9_-]+$/i.test(username)
      ? "Letters, numbers, underscores, and hyphens only"
      : undefined;

  const passwordError =
    password && password.length < 8
      ? "Must be at least 8 characters"
      : undefined;

  const confirmError =
    confirmPassword && confirmPassword !== password
      ? "Passwords do not match"
      : undefined;

  const canSubmit =
    username &&
    password &&
    confirmPassword &&
    !usernameError &&
    !passwordError &&
    !confirmError &&
    !loading;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);

    try {
      const passwordHash = await hashPassword(username, password);
      const token = await rpcStub.createAccount(
        username,
        username,
        passwordHash,
      );
      if (token) {
        localStorage.setItem("authToken", token);
        window.location.href = "/";
      } else {
        setError("ユーザー名はすでに存在します");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "アカウントの作成に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  if (!serverConfig) {
    if (serverConfigError && !connectionLost) {
      return (
        <div
          role="alert"
          className="min-h-screen flex flex-col items-center justify-center gap-4 bg-kumo-base px-4"
        >
          <p className="text-sm text-kumo-danger text-center">
            展開設定を読み込めませんでした。
          </p>
          <Button variant="secondary" onClick={() => window.location.reload()}>再読み込み</Button>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-kumo-base px-4">
        <Loader size="lg" />
        <p className="text-sm text-kumo-subtle text-center">
          {connectionLost ? "サーバーに接続できません。再試行中…" : "読み込み中…"}
        </p>
      </div>
    );
  }

  const authVendors = serverConfig.authVendors ?? [];
  const signupsEnabled = serverConfig.signupsEnabled;
  // The password create-account form requires both password auth AND open signups.
  const passwordAuthEnabled = serverConfig.passwordAuthEnabled && signupsEnabled;

  return (
    <div className="min-h-screen flex items-center justify-center bg-kumo-base px-4 relative overflow-hidden">
      {/* Dot grid — fades from top to bottom */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--color-kumo-line) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)",
        }}
      />

      <div className="w-full max-w-sm relative">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <SiteLogo size={40} className="mb-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-kumo-brand mb-3">
              <Hexagon size={20} className="text-white" weight="bold" />
            </div>
          </SiteLogo>
          <h1 className="text-xl font-semibold text-kumo-default">
            {siteName}
          </h1>
          <p className="text-sm text-kumo-subtle mt-1">アカウントを作成</p>
        </div>

        {!signupsEnabled && (
          <Banner
            variant="default"
            title="新規登録は停止中です"
            className="mb-4"
          >
            現在、この展開では新しいアカウントの登録が無効になっています。
          </Banner>
        )}

        {passwordAuthEnabled && (
          <>
            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label="ユーザー名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                disabled={loading}
                placeholder="あなたのユーザー名"
                error={usernameError}
              />

              <Input
                type="password"
                label="パスワード"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                disabled={loading}
                placeholder="••••••••"
                error={passwordError}
              />

              <Input
                type="password"
                label="パスワードを認証する"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                disabled={loading}
                placeholder="••••••••"
                error={confirmError}
              />

              {error && <Banner variant="error" title={error} />}

              <Button
                type="submit"
                variant="primary"
                disabled={!canSubmit}
                loading={loading}
                className="w-full justify-center"
              >
                アカウントを作成する
              </Button>
            </form>
          </>
        )}

        {/* Gatekeeper sign-in options, shown whenever any auth vendor is configured. */}
        {authVendors.length > 0 && (
          <div className={passwordAuthEnabled ? "mt-6" : ""}>
            {passwordAuthEnabled && (
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-kumo-line" />
                <span className="text-xs text-kumo-subtle">または</span>
                <div className="h-px flex-1 bg-kumo-line" />
              </div>
            )}
            <OAuthButtons rpcStub={rpcStub} vendors={authVendors} />
          </div>
        )}

        {passwordAuthEnabled && (
          <p className="text-center text-sm text-kumo-subtle mt-6">
            すでにアカウントをお持ちですか?{" "}
            <Link to="/" className="text-kumo-brand hover:underline font-medium">
              サインイン
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
