import { useEffect, useState } from "react";
import { EnclaveClient, type Health, type Policies, type ArcReceiptCount } from "./api";
import { VerificationHeader } from "./VerifyReceiptPage";
import { releaseUpdates } from "./release-updates";
import { configuredArcPaymentPolicy } from "./arc-payment";

interface DeploymentSnapshot { health: Health; policies: Policies; at: string }

export function DeploymentStatusPage() {
  const [snapshot, setSnapshot] = useState<DeploymentSnapshot | null>(null);
  const [error, setError] = useState(""); const [refresh, setRefresh] = useState(0);
  const [receiptCount, setReceiptCount] = useState<ArcReceiptCount | null>(null);
  useEffect(() => {
    const client = new EnclaveClient({ timeoutMs: 10_000 }); let active = true;
    setSnapshot(null); setError("");
    setReceiptCount(null);
    void Promise.all([client.health(), client.policies()]).then(([health, policies]) => {
      if (!active) return;
      if (health.servingModel.codeHash.toLowerCase() !== policies.active.measurement.toLowerCase() || policies.active.status !== "active") throw new Error("The gateway reports inconsistent model and policy state. Refresh after the operator resolves it.");
      setSnapshot({ health, policies, at: new Date().toISOString() });
    }).catch(() => { if (active) setError("Deployment details are unavailable or inconsistent. No live or production status has been established."); });
    const readCount = () => { void client.arcReceiptCount().then(count => { if (active) setReceiptCount(count); }).catch(() => { if (active) setReceiptCount(null); }); };
    readCount(); const timer = setInterval(readCount, 30_000);
    return () => { active = false; clearInterval(timer); client.disconnect(); };
  }, [refresh]);
  return <DeploymentStatusContent snapshot={snapshot} error={error} receiptCount={receiptCount}
    arcPaymentsConfigured={configuredArcPaymentPolicy() !== null} refreshStatus={() => setRefresh(value => value + 1)} />;
}

export function DeploymentStatusContent({ snapshot, error, receiptCount, arcPaymentsConfigured, refreshStatus }: {
  snapshot: DeploymentSnapshot | null; error: string; receiptCount: ArcReceiptCount | null;
  arcPaymentsConfigured: boolean; refreshStatus: () => void;
}) {
  const health = snapshot?.health, policy = snapshot?.policies.active;
  const deployment = health?.deployment;
  const arcPaymentsEnabled = arcPaymentsConfigured && health?.chainId === 5042 && health.paymentMode === "authorized";
  const badge = !snapshot ? error ? "STATUS UNAVAILABLE" : "CHECKING GATEWAY"
    : deployment?.productionReady ? "PRODUCTION · REPORTED READY"
    : deployment?.stage === "pilot" ? "PILOT · PRODUCTION NOT READY"
    : deployment?.stage === "development" ? "DEVELOPMENT · PRODUCTION NOT READY"
    : "RELEASE STATUS NOT REPORTED";
  const fields = health && policy ? {
    "Checked at": snapshot!.at,
    "Release stage": deployment?.stage ?? "Not reported",
    "Production readiness": deployment ? deployment.productionReady ? "Reported ready" : "Reported not ready" : "Not reported",
    "Release profile": deployment?.releaseProfile ?? "Not reported",
    "Network": health.chainId === 31337 ? "Local Anvil · chain 31337 · test funds" : health.chainId === 5042 ? "Arc · chain 5042" : `Chain ${health.chainId} · network classification not independently verified`,
    "Model": health.servingModel.name, "Model hash": health.servingModel.modelHash, "Serving code hash": health.servingModel.codeHash,
    "Inference provider": health.inferenceBackend,
    "Inference route": health.inferenceRoute === "near-direct-experimental" ? "Experimental direct NEAR"
      : health.inferenceRoute === "near-cloud-gateway" ? "NEAR Cloud Gateway" : health.inferenceRoute === "development" ? "Development" : "Not reported",
    "Inference trust": deployment?.inferenceTrust ?? "Not reported",
    "Provider policy SHA-256": health.providerPolicy?.sha256 ?? "Not reported",
    "Provider policy expires at": health.providerPolicy?.expiresAt ?? "Not reported",
    "Gateway policy version": String(policy.version), "Gateway policy hash": policy.policyHash, "Gateway policy binding": policy.binding ?? "Not reported",
    "Gateway key custody": deployment?.gatewayKeyCustody === "software" ? "Software-managed keys" : "Not reported",
    "Gateway sessions": "Software admission and encrypted transport to the gateway",
    "Request handling": health.inferenceBackend === "near-verified" ? "The application gateway decrypts requests before sending them to NEAR" : "The application gateway decrypts requests before inference",
    "Receipt signer": health.receiptSigner, "Verifier contract": health.verifierAddress,
    "Settlement": health.paymentMode === "mock" ? "Mock payment flow; uses test funds" : "Signed authorization flow; each payment requires wallet approval",
    "Browser Arc payments": arcPaymentsEnabled ? "Enabled by this site's payment configuration" : "Not enabled for this site's current configuration",
    "Configured token": health.settlementToken ?? "Not reported", "Price per call": `${health.inferencePriceUsdc} USDC`,
    "Provider timeout": health.limits ? `${health.limits.inferenceTimeoutMs / 1000} seconds` : "Not reported",
    "Maximum output tokens": health.limits?.maxOutputTokens != null ? String(health.limits.maxOutputTokens) : "Not reported for this provider",
  } : null;
  return <><VerificationHeader /><main className="verification-main en-container"><span className="eyebrow">/DEPLOYMENT TRANSPARENCY</span><h1>Know what is running.</h1>
    <p className="verification-intro">Public settings from this site’s gateway. No API key is required. These reported values help identify a deployment; they are not independent hardware evidence.</p>
    <span className="deployment-badge">{badge}</span>
    <div className="verification-grid"><section className="panel" aria-label="Deployment details"><h2>Network, model and policy</h2>
      <div aria-live="polite">{fields ? <dl>{Object.entries(fields).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl> : <p>{error || "Reading gateway settings…"}</p>}</div>
      <button className="en-button secondary" type="button" onClick={refreshStatus}>Refresh status</button>
    </section><section className="panel"><h2>Current limits</h2><ul className="deployment-limits">
      {!health ? <li>Refresh once the gateway is available to read its deployment settings.</li>
        : !deployment ? <li>The gateway does not report a release stage or production readiness.</li>
        : deployment.stage === "pilot" ? <li>This is a pilot deployment. The gateway does not report production readiness.</li>
        : !deployment.productionReady ? <li>This deployment does not report production readiness. Release acceptance is still required.</li>
        : <li>The gateway reports that its production release checks passed. This page does not independently verify the accepted release or current deployment.</li>}
      <li>Gateway sessions provide software admission. Gateway key custody is software-managed; release readiness does not imply hardware custody of local keys.</li>
      {health?.inferenceBackend === "near-verified" && <li>The gateway checks remote CPU and GPU evidence against its provider policy before provider requests. That policy is separate from the gateway session policy.</li>}
      {health?.paymentMode === "mock" && <li>Mock settlement uses test funds. It does not establish a real USDC payment.</li>}
      {health?.paymentMode === "authorized" && <li>Authorized settlement requires a signed wallet authorization. A configured token and network do not independently prove payment or production readiness.</li>}
      {health && <li>{arcPaymentsEnabled ? "Browser Arc payments are enabled by this site's configuration. Each real USDC payment requires your explicit wallet approval."
        : "Browser Arc payments are not enabled for this site's current configuration. Payments require a configured Arc deployment and explicit wallet approval."}</li>}
      {health && !health.agentRuntimeEnabled && <li>Autonomous agent jobs are not enabled on this gateway.</li>}
      <li>A receipt signature does not by itself prove hardware attestation, payment, anchoring or the contents of a prompt and response.</li>
    </ul><a className="text-link" href="/verify">Verify a downloaded receipt ↗</a>{health?.chainId === 5042 && <p><a className="text-link" href="https://docs.arc.io/arc/references/connect-to-arc" target="_blank" rel="noreferrer">Read the Arc network documentation ↗</a></p>}</section></div>
    <section className="panel" aria-label="Arc receipt count"><h2>Confirmed Arc receipts</h2>
      <p>{receiptCount ? `${receiptCount.confirmed} receipts confirmed on Arc (chain ${receiptCount.chainId})` : "Count unavailable"}</p>
      <p className="field-note">Counted from receipts whose Arc anchor transaction was confirmed by the gateway worker. It does not include pending or local simulation records.</p></section>
    <section className="panel" aria-label="Update history"><h2>Update history</h2><p>Selected reviewed repository and deployment updates. This is not a service uptime log.</p>
      <ol className="deployment-limits">{releaseUpdates.map(update => <li key={`${update.date}:${update.title}`}><time dateTime={update.date}>{update.date}</time> · <strong>{update.title}</strong> — {update.detail} <code>{update.revision}</code>
        {"links" in update && update.links.map(link => <span key={link.url}> · <a href={link.url} target="_blank" rel="noreferrer">{link.label} ↗</a></span>)}</li>)}</ol>
      <a className="text-link" href="/models">Browse the public model registry ↗</a></section>
  </main></>;
}
