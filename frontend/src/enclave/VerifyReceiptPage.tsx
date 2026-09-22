import { useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_RECEIPT_BYTES, browserRpc, parseReceipt, trustSchema, verifyLocalReceipt, verifyOnchainReceipt } from "./receipt-verifier";
import "./verification.css";

export function VerificationHeader() {
  return <header className="en-nav verification-nav"><a className="brand" href="/">Enclave</a><nav aria-label="Main navigation"><a href="/dashboard">Workspace</a><a href="/verify">Verify receipt</a><a href="/status">Deployment status</a></nav></header>;
}

export function VerifyReceiptPage() {
  const [ready, setReady] = useState(false);
  const [json, setJson] = useState("");
  const [chainId, setChainId] = useState("");
  const [verifier, setVerifier] = useState("");
  const [signer, setSigner] = useState("");
  const [rpcUrl, setRpcUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ title: string; fields: Record<string, string> } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null), revision = useRef(0);
  useEffect(() => { setReady(true); return () => { revision.current++; controller.current?.abort(); }; }, []);
  function invalidate() { revision.current++; controller.current?.abort(); setBusy(false); setError(""); setResult(null); }
  function update(setter: (value: string) => void, value: string) { invalidate(); setter(value); }
  async function readFile(file?: File) {
    invalidate(); if (!file) return; setJson("");
    const current = revision.current;
    if (file.size > MAX_RECEIPT_BYTES) { setJson(""); setError("Receipt exceeds the 64 KiB limit."); return; }
    setBusy(true);
    try { const text = await file.text(); if (current === revision.current) setJson(text); }
    catch { if (current === revision.current) { setJson(""); setError("The selected file could not be read."); } }
    finally { if (current === revision.current) setBusy(false); }
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); invalidate();
    const current = revision.current, abort = new AbortController(); controller.current = abort;
    const mode = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? "local";
    setBusy(true);
    try {
      const receipt = parseReceipt(json);
      const parsed = trustSchema.safeParse({ chainId: /^\d+$/.test(chainId) ? Number(chainId) : NaN, verifierAddress: verifier.trim(), signer: signer.trim() });
      if (!parsed.success) throw new Error("Enter a valid trusted chain ID, verifier address and signer address.");
      const checked = mode === "chain" ? await verifyOnchainReceipt(receipt, parsed.data, browserRpc(rpcUrl, abort.signal)) : await verifyLocalReceipt(receipt, parsed.data);
      if (revision.current !== current) return;
      const fields: Record<string, string> = { "Receipt hash": checked.digest, "Signer": checked.signer, "Chain ID": String(receipt.chainId), "Verifier": receipt.verifierAddress, "Model hash": receipt.modelHash, "Code hash": receipt.codeHash, "Input hash": receipt.inHash, "Output hash": receipt.outHash, "Attestation reference": receipt.attRef, "Timestamp (Unix seconds)": receipt.ts };
      if (checked.kind === "chain") Object.assign(fields, { "Checked at block": checked.blockNumber, "Model registry": checked.registry, "Listing ID": checked.listingId, "Policy version": checked.policyVersion, "Policy hash": checked.policyHash,
        "Policy binding": checked.policyBound ? "Present in ModelRegistry. Compare with the approved deployment policy." : "Missing. This check does not establish policy-bound approval.",
        "Anchor": checked.anchor.status === "confirmed" ? `Matching event found; ${checked.anchor.confirmations} confirmation(s). This is not a finality guarantee.` : checked.anchor.status === "pending" ? "Transaction not found or still pending. Anchoring is not confirmed." : "No anchor transaction supplied. Contract acceptance alone does not prove anchoring." });
      else fields["On-chain state"] = "Not checked. No RPC request was sent.";
      setResult({ title: mode === "chain" ? "Signature and current contract checks passed" : "Local signature and receipt hash verified", fields });
    } catch (reason) { if (revision.current === current) setError(reason instanceof Error && reason.name !== "ZodError" ? reason.message : "Verification failed: the receipt or RPC response is invalid."); }
    finally { if (revision.current === current) setBusy(false); }
  }
  return <><VerificationHeader /><main className="verification-main en-container">
    <span className="eyebrow">/INDEPENDENT VERIFICATION</span><h1>Verify a receipt.</h1>
    <p className="verification-intro">Check a downloaded Enclave receipt without signing in. Local verification stays in this tab. On-chain verification sends only receipt hashes, signature and contract calls to the RPC you choose; it never submits a transaction.</p>
    <div className="verification-grid"><form className="panel verification-form" onSubmit={verify}>
      <fieldset disabled={!ready}>
      <h2>Receipt and trust settings</h2>
      <label htmlFor="receipt-file">Open receipt JSON <span>(up to 64 KiB)</span></label><input ref={fileInput} id="receipt-file" type="file" accept=".json,application/json" onChange={e => { void readFile(e.target.files?.[0]); }} />
      <label htmlFor="receipt-json">Or paste a single receipt</label><textarea id="receipt-json" rows={10} value={json} onChange={e => update(setJson, e.target.value)} spellCheck={false} autoComplete="off" required maxLength={MAX_RECEIPT_BYTES} />
      <p className="field-note">Get the expected network, verifier and signer from a trusted deployment record. Values copied only from the receipt cannot establish who you trust. <a href="/status">View this deployment’s reported settings.</a></p>
      <label htmlFor="trusted-chain">Trusted chain ID</label><input id="trusted-chain" inputMode="numeric" placeholder="e.g. 31337 for local Anvil" value={chainId} onChange={e => update(setChainId, e.target.value)} required autoComplete="off" />
      <label htmlFor="trusted-verifier">Trusted verifier address</label><input id="trusted-verifier" placeholder="0x…" value={verifier} onChange={e => update(setVerifier, e.target.value)} required spellCheck={false} autoComplete="off" />
      <label htmlFor="trusted-signer">Trusted receipt signer</label><input id="trusted-signer" placeholder="0x…" value={signer} onChange={e => update(setSigner, e.target.value)} required spellCheck={false} autoComplete="off" />
      <label htmlFor="receipt-rpc">RPC URL <span>(for on-chain checks only)</span></label><input id="receipt-rpc" placeholder="https://…" type="url" value={rpcUrl} onChange={e => update(setRpcUrl, e.target.value)} spellCheck={false} autoComplete="off" />
      <div className="verification-actions"><button className="en-button" type="submit" value="local" disabled={busy}>Verify locally</button><button className="en-button secondary" type="submit" value="chain" disabled={busy || !rpcUrl.trim()}>Verify on-chain</button><button className="plain-button" type="button" onClick={() => { invalidate(); setJson(""); setChainId(""); setVerifier(""); setSigner(""); setRpcUrl(""); if (fileInput.current) fileInput.current.value = ""; }}>Clear</button></div>
      <p role="status" aria-live="polite">{busy ? "Verifying…" : ""}</p><p className="form-error" role="alert">{error}</p>
      </fieldset>
    </form><section className="panel verification-results" aria-label="Verification result" aria-live="polite">
      <h2>{result?.title ?? "Results appear here"}</h2>
      {result ? <dl>{Object.entries(result.fields).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl> : <p>Import a receipt and enter the trusted deployment settings to start.</p>}
      <div className="verification-boundary"><h3>What this check proves</h3><p>A valid signature binds these fields to the signer and EIP-712 domain. It does not independently verify CPU/GPU attestation, protected key custody, the original prompt or response, or a USDC payment.</p><p>On-chain checks evaluate the contract’s current signer and model policy at the displayed block. A valid receipt can fail after a signer rotation or model revocation. RPC results rely on the endpoint you selected.</p></div>
    </section></div>
  </main></>;
}
