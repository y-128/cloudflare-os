import { useTranslation } from "@gadgets/i18n";
import { Component, type ReactNode } from "react";
import { reportIssue } from "./error-reporting";

export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: Error) {
    reportIssue("scheduler.react-render", error, {
      handled: false,
      severity: "fatal",
      captureMechanism: "react",
    });
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    return <ErrorFallback />;
  }
}

const ErrorFallback = () => {
  const { t } = useTranslation();
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-lg font-semibold">{t("gatekeeper-scheduler.ErrorBoundary.something_went_wrong")}</h1>
        <button className="rounded-md border px-3 py-2" onClick={() => location.reload()}>
          {t("gatekeeper-scheduler.ErrorBoundary.reload")}</button>
      </main>
    );
};
