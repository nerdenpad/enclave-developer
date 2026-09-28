import { useEffect, useState } from "react";
import { EnclaveClient, type Health, type Policies, type ArcReceiptCount } from "./api";
import { VerificationHeader } from "./VerifyReceiptPage";
import { releaseUpdates } from "./release-updates";

export function DeploymentStatusPage() {
  const [snapshot, setSnapshot] = useState<{ health: Health; policies: Policies; at: string } | null>(null);
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
  const health = snapshot?.health, policy = snapshot?.policies.active;
  const fields = health && policy ? {
    "Checked at": snapshot!.at,
    "Network": health.chainId === 31337 ? "Local Anvil · chain 31337 · test funds" : `Chain ${health.chainId} · network classification not independently verified`,
    "Model": health.servingModel.name, "Model hash": health.servingModel.modelHash, "Serving code hash": health.servingModel.codeHash,
    "Inference provider": health.inferenceBackend,
    "Gateway policy version": String(policy.version), "Gateway policy hash": policy.policyHash, "Gateway policy binding": policy.binding ?? "Not reported",
    "Gateway custody": "Development software; hardware key custody is not enabled",
    "Receipt signer": health.receiptSigner, "Verifier contract": health.verifierAddress,
    "Settlement": health.paymentMode === "mock" ? "Mock payment flow; not a real USDC deployment" : "Signed authorization flow; token and network still require operator review",
    "Configured token": health.settlementToken ?? "Not reported", "Price per call": `${health.inferencePriceUsdc} USDC`,
    "Provider timeout": health.limits ? `${health.limits.inferenceTimeoutMs / 1000} seconds` : "Not reported",
    "Maximum output tokens": health.limits?.maxOutputTokens != null ? String(health.limits.maxOutputTokens) : "Not reported for this provider",
  } : null;
  return <><VerificationHeader /><main className="verification-main en-container"><span className="eyebrow">/DEPLOYMENT TRANSPARENCY</span><h1>Know what is running.</h1>
    <p className="verification-intro">Public settings from this site’s gateway. No API key is required. These reported values help identify a deployment; they are not independent hardware evidence.</p>
    <span className="deployment-badge">{snapshot ? "DEVELOPMENT · E1 NOT RELEASED" : error ? "STATUS UNAVAILABLE" : "CHECKING GATEWAY"}</span>
    <div className="verification-grid"><section className="panel" aria-label="Deployment details"><h2>Network, model and policy</h2>
      <div aria-live="polite">{fields ? <dl>{Object.entries(fields).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl> : <p>{error || "Reading gateway settings…"}</p>}</div>
      <button className="en-button secondary" type="button" onClick={() => setRefresh(value => value + 1)}>Refresh status</button>
    </section><section className="panel"><h2>Current limits</h2><ul className="deployment-limits">
      <li>The gateway, session keys, receipt signer and agent state run in software. Production mode remains blocked.</li>
      <li>The NEAR adapter checks remote CPU and GPU evidence before sending a prompt. This does not establish hardware custody of our gateway keys. Its reviewed provider policy is separate from the gateway policy shown here.</li>
      <li>Local Anvil settlement uses test funds. A token address and an authorized payment mode do not prove a production USDC deployment.</li>
      <li>The browser workspace does not submit real-network wallet authorizations or launch autonomous agent jobs.</li>
      <li>A receipt signature does not by itself prove hardware attestation, payment, anchoring or the contents of a prompt and response.</li>
    </ul><a className="text-link" href="/verify">Verify a downloaded receipt ↗</a></section></div>
    <section className="panel" aria-label="Arc receipt count"><h2>Confirmed Arc receipts</h2>
      <p>{receiptCount ? `${receiptCount.confirmed} receipts confirmed on Arc (chain ${receiptCount.chainId})` : "Count unavailable"}</p>
      <p className="field-note">Counted from receipts whose Arc anchor transaction was confirmed by the gateway worker. It does not include pending or local simulation records.</p></section>
    <section className="panel" aria-label="Update history"><h2>Update history</h2><p>Selected repository changes. This is not a service uptime log.</p>
      <ol className="deployment-limits">{releaseUpdates.map(update => <li key={update.revision}><time dateTime={update.date}>{update.date}</time> · <strong>{update.title}</strong> — {update.detail} <code>{update.revision}</code></li>)}</ol>
      <a className="text-link" href="/models">Browse the public model registry ↗</a></section>
  </main></>;
}
