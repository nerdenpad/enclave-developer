import { useEffect, useState } from "react";
import { EnclaveClient, type PublicModel } from "./api";
import { VerificationHeader } from "./VerifyReceiptPage";

export function ModelRegistryPage() {
  const [models, setModels] = useState<PublicModel[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const client = new EnclaveClient({ timeoutMs: 10_000 }); let active = true;
    const load = () => { void client.publicModels().then(rows => { if (active) { setModels(rows); setError(false); } }).catch(() => { if (active) setError(true); }); };
    load(); const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); client.disconnect(); };
  }, []);
  return <><VerificationHeader /><main className="verification-main en-container"><span className="eyebrow">/PUBLIC MODEL REGISTRY</span><h1>Registered models.</h1>
    <p className="verification-intro">Public hashes and approval status reported by the gateway. A registered entry does not establish that a model is currently serving or running in GPU TEE.</p>
    <section className="panel" aria-live="polite">{error ? <p>Registry unavailable. Please try again later.</p> : models === null ? <p>Loading registry…</p> : models.length === 0 ? <p>No models registered.</p> : <div className="table-wrap"><table><thead><tr><th>VERSION</th><th>MODEL HASH</th><th>CODE HASH</th><th>STATUS</th><th>LISTING</th></tr></thead><tbody>{models.map(model => <tr key={`${model.modelHash}:${model.codeHash}`}><td>{model.version}</td><td><code>{model.modelHash}</code></td><td><code>{model.codeHash}</code></td><td>{model.revoked ? "Revoked" : model.approved ? "Approved" : "Pending"}</td><td>{model.listingId ?? "—"}</td></tr>)}</tbody></table></div>}</section>
  </main></>;
}
