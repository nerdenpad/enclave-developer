import { useEffect, useState } from "react";
import { EnclaveClient, type Health } from "./api";
import { configuredArcPaymentPolicy } from "./arc-payment";
import { deploymentCopy } from "./deployment-copy";

export function PublicDeploymentNotice({ pathname }: { pathname: string }) {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    const client = new EnclaveClient({ timeoutMs: 10_000 }); let active = true;
    setHealth(null);
    void client.health().then(value => { if (active) setHealth(value); }).catch(() => { if (active) setHealth(null); });
    return () => { active = false; client.disconnect(); };
  }, [pathname]);
  const copy = deploymentCopy(health, configuredArcPaymentPolicy() !== null);
  useEffect(() => {
    for (const details of document.querySelectorAll('[data-runtime-copy="home-details"]')) {
      const link = document.createElement("a"); link.href = "/status"; link.textContent = "View deployment status";
      details.replaceChildren(document.createTextNode(`${copy.homeDetails} `), link);
    }
    for (const summary of document.querySelectorAll('[data-runtime-copy="home-summary"]')) summary.textContent = copy.summary;
  }, [copy.homeDetails, copy.summary, pathname]);
  return <aside className="deployment-notice" aria-label="Release status">{copy.summary} · <a href="/status">View deployment status</a></aside>;
}
