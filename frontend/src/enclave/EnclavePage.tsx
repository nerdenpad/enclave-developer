import { useEffect } from "react";
import routes from "./routes.json";
import homeStyles from "./home-reference.css?raw";
import "./dashboard.css";
import { VerifyReceiptPage } from "./VerifyReceiptPage";
import { DeploymentStatusPage } from "./DeploymentStatusPage";
import { WalletConnectControl } from "./WalletConnectControl";

const pages = import.meta.glob("./pages/*.html", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type RouteMeta = { file?: string; title: string; description: string };

export function normalizePath(pathname: string): string {
  return pathname.replace(/\/index\.html$/, "/").replace(/\/?$/, "/");
}

export function getRouteMeta(pathname: string): RouteMeta {
  const key = normalizePath(pathname);
  const table = routes as Record<string, RouteMeta | undefined>;
  return table[key] ?? (table["/404/"] as RouteMeta);
}

export function headForPath(pathname: string) {
  const meta = getRouteMeta(pathname);
  return {
    meta: [
      { title: meta.title },
      { name: "description", content: meta.description },
      { property: "og:title", content: meta.title },
      { property: "og:description", content: meta.description },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Enclave" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  };
}

const loadScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Unable to load ${src}`));
    document.body.append(script);
  });

export function EnclavePage({ pathname }: { pathname: string }) {
  const path = normalizePath(pathname);
  const meta = getRouteMeta(pathname);
  const markup = pages[`./pages/${meta.file}`] ?? "";

  useEffect(() => {
    if (path === "/verify/" || path === "/status/") return;
    let cancelled = false;
    let disposeDashboard: (() => void) | undefined;
    void (async () => {
      // Navigation effects must not delay authentication or the workspace API.
      const decorations = loadScript("/site.js").catch(console.error);
      if (cancelled) return;
      if (path === "/dashboard/") {
        const { mountDashboard } = await import("./dashboard");
        if (cancelled) return;
        disposeDashboard = mountDashboard();
      }
      await decorations;
      if (cancelled) return;
      if (location.hash) {
        requestAnimationFrame(() =>
          document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView(),
        );
      }
    })().catch(console.error);
    return () => {
      cancelled = true;
      disposeDashboard?.();
    };
  }, [path]);

  if (path === "/verify/") return <VerifyReceiptPage />;
  if (path === "/status/") return <DeploymentStatusPage />;
  return (
    <>
      {path === "/" ? <style dangerouslySetInnerHTML={{ __html: homeStyles }} /> : null}
      {path !== "/dashboard/" && <aside className="deployment-notice" aria-label="Release status">Development pilot · Local test settlement · <a href="/status">View deployment status</a></aside>}
      <div id="site-document" style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: markup }} />
      {path === "/dashboard/" ? <WalletConnectControl /> : null}
    </>
  );
}
