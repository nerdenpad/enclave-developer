import { EnclaveClient, ApiError, canSettleLocally, type Health, type Workspace, type WorkspaceReceipt, type Model, type Policies, type PreparedInference, type VerifiedInference, type InferenceStep } from "./api";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (value: string) => value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
const units = (value: string) => { const amount = BigInt(value); return `${amount / 1000000n}.${(amount % 1000000n).toString().padStart(6, "0")}`; };
const date = (value: string) => new Date(value).toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function message(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "The API key was rejected or the session expired. Reconnect your workspace.";
    if (error.code === "MANDATE_LIMIT_EXCEEDED" || error.code.includes("LIMIT")) return "This request exceeds a spending limit. No inference was started.";
    if (error.status === 503) return "The gateway or inference provider is temporarily unavailable. The request was not retried. Check payment history before sending another request.";
    return `${error.message}${error.code ? ` · ${error.code}` : ""}`;
  }
  return error instanceof Error ? error.message : "The operation could not be completed.";
}

export function mountDashboard(): () => void {
  const root = document.querySelector(".dashboard-main");
  if (!root) return () => {};
  const life = new AbortController();
  const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`Workspace element missing: ${selector}`);
    return element;
  };
  const $$ = <T extends HTMLElement = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
  const input = (selector: string) => $<HTMLInputElement>(selector);
  const select = (selector: string) => $<HTMLSelectElement>(selector);
  const dialog = (selector: string) => $<HTMLDialogElement>(selector);
  const text = (selector: string, value: string) => { $(selector).textContent = value; };
  const on = (selector: string, event: string, handler: (event: Event) => void) => $(selector).addEventListener(event, handler, { signal: life.signal });
  let client: EnclaveClient | null = null;
  let health: Health | null = null;
  let workspace: Workspace | null = null;
  let models: Model[] = [];
  let policies: Policies | null = null;
  let pending: PreparedInference | null = null;
  let recovery: { client: EnclaveClient; request: PreparedInference } | null = null;
  let receipt: WorkspaceReceipt | null = null;
  let lastResult: VerifiedInference | null = null;
  let busy = false;
  let polling = false;
  let historyExpanded = false;
  let paginationBusy = false;
  let historyVersion = 0;
  let refreshRequest = 0;
  let pageRequest = 0;
  let receiptVerification = 0;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionVersion = 0;
  const options = { signal: life.signal };

  function notify(value: string) {
    clearTimeout(toastTimer); text("#toast", value); $("#toast").hidden = false;
    toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 5000);
  }
  function download(name: string, data: unknown, type = "application/json") {
    const blob = new Blob([typeof data === "string" ? data : JSON.stringify(data, null, 2)], { type });
    const href = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = href; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  function navigate(view: string) {
    const target = document.getElementById(`view-${view}`); if (!target) return;
    $$<HTMLButtonElement>("[data-view]").forEach((button) => { const active = button.dataset["view"] === view; button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1; });
    $$(".dash-view").forEach((panel) => { panel.hidden = panel !== target; });
    const url = new URL(location.href); url.searchParams.set("view", view); history.replaceState({}, "", url);
  }
  function setBusy(value: boolean) {
    busy = value;
    $$<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("#inference-form input,#inference-form select,#inference-form textarea,#inference-form button").forEach((control) => { control.disabled = value || Boolean(recovery); });
    select("#model-select").disabled = true;
    $<HTMLButtonElement>("#run-inference").disabled = value || !client || Boolean(recovery);
    text("#run-inference span", value ? "Request in progress…" : "Run inference");
    $<HTMLButtonElement>("#disconnect-gateway").disabled = value;
    $<HTMLButtonElement>("#retry-inference").disabled = value;
    $<HTMLButtonElement>("#dismiss-recovery").disabled = value;
  }
  function step(index: number, state: string, label: string) {
    const li = $(`[data-step="${index}"]`); li.className = state; li.querySelector("i")!.textContent = label;
  }
  function onStep(state: InferenceStep) {
    if (life.signal.aborted) return;
    if (state === "connecting" || state === "attesting") { step(0, "active", "Checking"); text("#output-status", "Opening a gateway session"); }
    if (state === "encrypting") { step(0, "done", "Admitted"); text("#output-status", "Encrypting request"); }
    if (state === "payment-required") { step(1, "active", "Required"); text("#output-status", "Awaiting payment confirmation"); }
    if (state === "settling") { step(1, "active", "Settling"); text("#output-status", "Settling test USDC"); }
    if (state === "inferencing") { step(1, "done", "Settled"); step(2, "active", "Running"); text("#output-status", "Waiting for the model response"); }
    if (state === "verifying") { step(2, "done", "Received"); step(3, "active", "Verifying"); text("#output-status", "Decrypting and verifying"); }
    if (state === "complete") { step(3, "done", "Verified"); text("#output-status", "Response verified"); }
  }
  function renderHealth() {
    if (!health) return;
    const near = health.inferenceBackend === "near-verified";
    const echo = health.inferenceBackend === "echo";
    const local = canSettleLocally(health);
    const label = near ? "NEAR GPU · DEVELOPMENT GATEWAY" : echo ? "LOCAL ECHO · DEVELOPMENT" : "MODEL ENDPOINT · DEVELOPMENT GATEWAY";
    text("#environment-badge", label);
    text("#environment-description", near ? "Verified remote GPU inference. The gateway and its keys run in software." : echo ? "Real gateway, database and receipt signatures. The echo provider is a development fixture." : "Model inference through an OpenAI-compatible endpoint. The gateway and its keys run in software; this adapter does not verify provider hardware.");
    text("#connection-status", `Connected · ${client!.baseUrl}`);
    $("#connection-status").dataset["connected"] = "true";
    text("#connection-note", `Chain ${health.chainId} · ${health.paymentMode} payments · gateway ${health.teeMode}`);
    text("#request-environment", near ? "NEAR GPU" : health.inferenceBackend.toUpperCase());
    select("#model-select").innerHTML = `<option value="${escape(health.servingModel.modelHash)}">${escape(health.servingModel.name)}</option>`;
    text("#request-note", `Serving ${health.servingModel.name}. Price: ${health.inferencePriceUsdc.toFixed(6)} ${local ? "test " : ""}USDC per call. ${near ? "Remote CPU/GPU evidence is checked by the gateway." : echo ? "Echo is a test provider, not an LLM." : "The configured model endpoint serves the request without hardware verification by this adapter."}`);
    text("#session-trust-note", health.teeMode === "dev" ? "Development software policy · no hardware gateway" : "Gateway-reported attestation policy");
    text("#provider-trust-note", near ? "NEAR evidence verified by the gateway" : echo ? "Local echo development fixture" : "OpenAI-compatible model endpoint · hardware not verified");
    text("#payment-network", local ? "Local EVM · 31337" : `EVM chain ${health.chainId}`);
    text("#payment-description", local ? `Local-chain payment uses test USDC.${echo ? " The echo provider is a local fixture." : " Remote provider usage can still be billed."}` : "A wallet authorization is required. This interface does not submit real-network payments.");
    text("#registry-status", "BACKEND REGISTRY");
    text("#metric-environment", near ? "NEAR GPU / dev gateway" : echo ? "Local echo development" : "Model endpoint / dev gateway");
    text("#topology-status", near ? "NEAR GPU + SOFTWARE GATEWAY" : echo ? "LOCAL DEVELOPMENT" : "MODEL ENDPOINT + SOFTWARE GATEWAY");
    text("#topology-provider", near ? "NEAR GPU provider" : echo ? "Local echo provider" : "OpenAI-compatible model provider");
    text("#topology-boundary", "Software gateway · explicit trust boundary");
    text("#topology-chain", `CHAIN ${health.chainId} · ${local ? "TEST USDC" : "USDC"} · x402`);
    text("#agent-model-note", `Allowed model: ${health.servingModel.name}. The gateway enforces the daily limit before execution.`);
    if (policies) {
      text("#topology-policy", `POLICY / V${policies.active.version}`);
      const fields = { "Policy version": policies.active.version, "Policy status": policies.active.status, "Serving image": policies.active.servingImageId, "Gateway custody": "Development software", "Inference provider": health.inferenceBackend, "Receipt signer": health.receiptSigner, "Contract": health.verifierAddress };
      $("#policy-details").innerHTML = Object.entries(fields).map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join("");
    }
    $("#model-cards").innerHTML = models.length ? models.map((model) => {
      const serving = model.modelHash === health!.servingModel.modelHash && model.codeHash === health!.servingModel.codeHash;
      return `<article class="model-card"><div class="model-icon">${serving ? "GPU" : "REG"}</div><h3>${escape(serving ? health!.servingModel.name : model.version)}</h3><span class="small-tag">${serving ? "SERVING NOW" : "REGISTERED"}</span><p>${escape(model.provider)} · ${escape(model.version)}</p><p><code>Model ${escape(short(model.modelHash))}<br>Code ${escape(short(model.codeHash))}</code></p><span class="eyebrow">APPROVED / LISTING ${model.listingId ?? "LOCAL"}</span>${serving ? '<button class="en-button secondary" data-goto="inference"><span>Open inference</span><b>↗</b></button>' : ""}</article>`;
    }).join("") : '<p class="workspace-empty">No approved models are available.</p>';
  }
  function renderReceipts() {
    const query = input("#receipt-search").value.trim().toLowerCase();
    const receipts = workspace?.receipts ?? [];
    const filtered = receipts.filter((record) => `${record.typedHash} ${record.modelHash} ${record.id}`.toLowerCase().includes(query));
    $("#receipt-rows").innerHTML = filtered.map((record) => `<tr><td><code>${escape(short(record.typedHash))}</code><small>${escape(record.id)}</small></td><td>${escape(record.modelHash === health?.servingModel.modelHash ? health.servingModel.name : short(record.modelHash))}</td><td>${date(record.createdAt)}</td><td>${escape(record.status)}</td><td><button class="text-link plain-button" data-receipt="${escape(record.typedHash)}">Inspect ↗</button></td></tr>`).join("") || (receipts.length ? '<tr><td colspan="5">No matching receipts.</td></tr>' : "");
    $("#receipts-empty").hidden = receipts.length > 0;
    $("#load-more-receipts").hidden = !workspace?.page.receiptsNext;
  }
  function renderWorkspace() {
    if (!workspace) return;
    text("#metric-calls", String(workspace.usage.calls));
    text("#metric-usage", units(workspace.usage.usdcUnits));
    text("#metric-receipts", String(workspace.receipts.length));
    text("#receipt-count", String(workspace.receipts.length));
    text("#payment-total", `${units(workspace.usage.usdcUnits)} USDC`);
    renderReceipts();
    $("#usage-rows").innerHTML = workspace.payments.length ? workspace.payments.map((payment) => `<tr><td><code>${escape(short(payment.id))}</code><small>${date(payment.createdAt)}</small></td><td>${health?.paymentMode === "mock" ? "Local test" : "Authorized"}${payment.agentId ? " / agent" : " / direct"}</td><td>${units(payment.amountUnits)} USDC</td><td>${escape(payment.status)}<small title="${escape(payment.settleTx)}">${payment.settleTx ? escape(short(payment.settleTx)) : "No settlement transaction"}</small></td></tr>`).join("") : '<tr><td colspan="4">No payments yet. Your first request will create a payment challenge.</td></tr>';
    $("#load-more-payments").hidden = !workspace.page.paymentsNext;
    $("#agent-cards").innerHTML = workspace.agents.length ? workspace.agents.map((agent) => `<article class="agent-card"><span class="agent-status">PERSISTED / ${escape(short(agent.id))}</span><h3>${escape(agent.name)}</h3><p>Daily spending and allowed models are enforced by the gateway.</p><dl><dt>Daily limit</dt><dd>${"dailyLimitUnits" in agent && typeof agent.dailyLimitUnits === "string" ? units(agent.dailyLimitUnits) + " USDC" : "See mandate policy"}</dd><dt>Spent today</dt><dd>${"spentTodayUnits" in agent && typeof agent.spentTodayUnits === "string" ? units(agent.spentTodayUnits) + " USDC" : "—"}</dd><dt>Policy hash</dt><dd><code>${escape(short(agent.policyHash))}</code></dd></dl><button class="en-button secondary" data-use-agent="${escape(agent.id)}"><span>Use this mandate</span><b>↗</b></button></article>`).join("") : '<p class="workspace-empty">No agents yet. Create a mandate to limit model access and daily spending.</p>';
    const old = select("#inference-agent").value;
    select("#inference-agent").innerHTML = workspace.agents.map((agent) => `<option value="${escape(agent.id)}">${escape(agent.name)}</option>`).join("");
    if (workspace.agents.some((agent) => agent.id === old)) select("#inference-agent").value = old;
    $("#load-more-agents").hidden = !workspace.page.agentsNext;
    text("#workspace-updated", historyExpanded ? "Older history loaded · automatic refresh paused. Refresh resets to the latest page." : `Updated ${new Date().toLocaleTimeString("en-GB")} · history persisted by gateway`);
    if (receipt && dialog("#receipt-dialog").open) {
      const updated = workspace.receipts.find((item) => item.typedHash === receipt!.typedHash);
      if (updated) { receipt = updated; renderReceiptDetail(); }
    }
  }
  async function refresh(quiet = false) {
    const active = client; if (!active || (quiet && (polling || historyExpanded || paginationBusy))) return;
    const generation = ++historyVersion, operation = ++refreshRequest;
    const resetsHistory = historyExpanded || paginationBusy;
    polling = true;
    try {
      const next = await active.workspace({}, options);
      if (client !== active || life.signal.aborted || generation !== historyVersion) return;
      historyExpanded = false; workspace = next; renderWorkspace();
      if (!quiet) notify(resetsHistory ? "History refreshed to the latest page. Load older records again as needed." : "Workspace history refreshed.");
    } catch (error) {
      if (!life.signal.aborted && client === active && generation === historyVersion) {
        text("#workspace-updated", "Refresh failed · displayed history may be out of date");
        if (!quiet) notify(message(error));
      }
    } finally { if (operation === refreshRequest) polling = false; }
  }
  function renderReceiptDetail() {
    if (!receipt) return;
    text("#receipt-notice", `${receipt.status.toUpperCase()} · EIP-712 v${receipt.receiptVersion} · chain ${receipt.chainId ?? "unknown"}. This signature does not independently verify hardware attestation.`);
    const fields = { "Receipt hash": receipt.typedHash, "Model hash": receipt.modelHash, "Code hash": receipt.codeHash, "Input hash": receipt.inHash, "Output hash": receipt.outHash, "Attestation reference": receipt.attRef, "Nonce": receipt.nonce, "Timestamp": receipt.ts, "Signature": receipt.sig, "Verifier": receipt.verifierAddress, "Anchor transaction": receipt.anchoredTx ?? "Pending worker confirmation" };
    $("#receipt-fields").innerHTML = Object.entries(fields).map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join("");
  }
  function openReceipt(hash: string) {
    receiptVerification++;
    receipt = workspace?.receipts.find((row) => row.typedHash === hash) ?? null;
    if (!receipt) { notify(historyExpanded ? "Refresh history to load the latest receipt." : "Receipt history is refreshing. Try again in a moment."); return; }
    renderReceiptDetail(); text("#receipt-integrity", ""); dialog("#receipt-dialog").showModal();
  }
  async function finish(result: VerifiedInference) {
    if (lastResult !== result) lastResult?.outputBytes.fill(0);
    lastResult = result; pending = null; recovery = null; $("#inference-recovery").hidden = true;
    text("#inference-output", result.outputText ?? `The provider returned ${result.outputBytes.length} binary bytes. The encrypted output and receipt hashes verified successfully.`);
    text("#output-status", "Response verified");
    $("#open-last-receipt").hidden = false;
    await refresh(true);
    notify("Response decrypted. Input, output and receipt signature verified.");
  }
  function clearWorkspace() {
    connectionVersion++; historyVersion++; refreshRequest++; pageRequest++; receiptVerification++;
    polling = false; paginationBusy = false; historyExpanded = false;
    client?.disconnect(); client = null; health = null; workspace = null; models = []; policies = null; pending = null; recovery = null; receipt = null;
    lastResult?.outputBytes.fill(0); lastResult = null;
    input("#api-key").value = ""; input("#view-key-secret").value = "";
    $("#view-key-result").hidden = true; $("#view-key-form").hidden = false;
    $("#connection-panel").classList.remove("connected"); $("#disconnect-gateway").hidden = true;
    $("#connection-status").dataset["connected"] = "false"; text("#connection-status", "Disconnected");
    text("#environment-badge", "NOT CONNECTED"); text("#environment-description", "Connect your gateway to load the workspace.");
    text("#connection-note", "Your API key stays in this tab. Provider credentials stay on the server.");
    for (const id of ["#metric-calls", "#metric-receipts", "#receipt-count"]) text(id, "0");
    text("#metric-usage", "0.000000"); text("#payment-total", "0.000000 USDC");
    text("#inference-output", "Connect a workspace to send an encrypted request."); text("#output-status", "Not connected");
    text("#metric-environment", "Not connected"); text("#topology-status", "NOT CONNECTED"); text("#topology-policy", "POLICY / DISCONNECTED"); text("#topology-chain", "USDC · x402"); text("#topology-provider", "Configured provider"); text("#payment-network", "Not connected"); text("#payment-description", "Connect to inspect payment mode and chain."); text("#workspace-updated", "History is stored by your gateway."); text("#registry-status", "NOT CONNECTED"); text("#request-note", "Connect to see the active model and execution environment.");
    $("#receipt-rows").innerHTML = ""; $("#receipt-fields").innerHTML = ""; $("#receipts-empty").hidden = false;
    $("#usage-rows").innerHTML = '<tr><td colspan="4">No payment history loaded.</td></tr>';
    $("#agent-cards").innerHTML = '<p class="workspace-empty">Connect your workspace to load agent mandates.</p>';
    $("#model-cards").innerHTML = '<p class="workspace-empty">Connect a gateway to load its registry.</p>';
    $("#policy-details").innerHTML = '<dt>Gateway</dt><dd>Not connected</dd>';
    select("#model-select").innerHTML = '<option>Connect a gateway</option>'; select("#inference-agent").innerHTML = "";
    $("#open-last-receipt").hidden = true;
    $("#inference-recovery").hidden = true; text("#recovery-payment", "");
    $$<HTMLButtonElement>("[id^=load-more-]").forEach((item) => { item.hidden = true; item.disabled = false; });
    $$<HTMLButtonElement>("[data-requires-connection]").forEach((item) => { item.disabled = true; });
    $$<HTMLDialogElement>("dialog").forEach((item) => item.close());
    input("#prompt").value = ""; text("#prompt-count", "0 / 4,000"); text("#inference-error", "");
    for (let i = 0; i < 4; i++) step(i, "", "Waiting");
    setBusy(false);
  }
  function executePrepared(active: EnclaveClient, request: PreparedInference) {
    if (busy && recovery) return;
    const version = connectionVersion;
    const current = () => !life.signal.aborted && client === active && version === connectionVersion;
    recovery = { client: active, request }; setBusy(true); text("#inference-error", "");
    void active.settleLocalAndRun(request, { ...options, onStep: (state) => { if (current()) onStep(state); } }).then(async (result) => {
      if (!current()) { result.outputBytes.fill(0); return; }
      await finish(result);
    }).catch((error: unknown) => {
      if (!current()) return;
      text("#inference-error", message(error)); text("#output-status", "Request interrupted · continuation available");
      text("#recovery-payment", `Payment ${request.challenge?.accepts[0]?.extra.paymentId ?? "unknown"}`);
      $("#inference-recovery").hidden = false; void refresh(true);
    }).finally(() => { if (current()) setBusy(false); });
  }

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const tab = event.target.closest<HTMLElement>("[data-view]"); if (tab) navigate(tab.dataset["view"]!);
    const go = event.target.closest<HTMLElement>("[data-goto]"); if (go) navigate(go.dataset["goto"]!);
    const chosen = event.target.closest<HTMLElement>("[data-receipt]"); if (chosen) openReceipt(chosen.dataset["receipt"]!);
    const agent = event.target.closest<HTMLElement>("[data-use-agent]"); if (agent) { select("#execution-mode").value = "agent"; $("#agent-choice").hidden = false; select("#inference-agent").value = agent.dataset["useAgent"]!; navigate("inference"); input("#prompt").focus(); }
    if (event.target.closest("[data-refresh]")) void refresh();
    const example = event.target.closest<HTMLElement>("[data-prompt]"); if (example && !busy && !recovery) { input("#prompt").value = example.dataset["prompt"]!; input("#prompt").dispatchEvent(new Event("input")); input("#prompt").focus(); }
  }, { signal: life.signal });
  $$<HTMLButtonElement>("[data-view]").forEach((button, index, buttons) => button.addEventListener("keydown", (event) => {
    const next = event.key === "ArrowDown" || event.key === "ArrowRight" ? (index + 1) % buttons.length : event.key === "ArrowUp" || event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
    if (next !== null) { event.preventDefault(); buttons[next]!.focus(); navigate(buttons[next]!.dataset["view"]!); }
  }, { signal: life.signal }));
  on("#prompt", "input", () => text("#prompt-count", `${input("#prompt").value.length} / 4,000`));
  on("#execution-mode", "change", () => { $("#agent-choice").hidden = select("#execution-mode").value !== "agent"; });
  on("#receipt-search", "input", renderReceipts);
  on("#disconnect-gateway", "click", () => { clearWorkspace(); notify("Workspace disconnected. Local secrets cleared."); });
  on("#connection-form", "submit", (event) => {
    event.preventDefault(); const version = ++connectionVersion;
    text("#connection-error", ""); $<HTMLButtonElement>("#connect-gateway").disabled = true;
    void (async () => {
      const next = new EnclaveClient({ apiKey: input("#api-key").value.trim(), baseUrl: input("#gateway-url").value.trim() });
      try {
        const [h, w, m, p] = await Promise.all([next.health(options), next.workspace({}, options), next.models(options), next.policies(options)]);
        if (version !== connectionVersion || life.signal.aborted) { next.disconnect(); return; }
        client?.disconnect(); client = next; health = h; workspace = w; models = m; policies = p;
        historyVersion++; refreshRequest++; pageRequest++; polling = false; paginationBusy = false; historyExpanded = false;
        input("#api-key").value = ""; $("#connection-panel").classList.add("connected"); $("#disconnect-gateway").hidden = false;
        $$<HTMLButtonElement>("[data-requires-connection]").forEach((button) => { button.disabled = false; });
        $$<HTMLButtonElement>("[id^=load-more-]").forEach((button) => { button.disabled = false; });
        renderHealth(); renderWorkspace(); notify("Workspace connected. History loaded from the backend.");
      } catch (error) { next.disconnect(); throw error; }
    })().catch((error: unknown) => { if (!life.signal.aborted) text("#connection-error", message(error)); }).finally(() => { if (!life.signal.aborted) $<HTMLButtonElement>("#connect-gateway").disabled = false; });
  });
  on("#inference-form", "submit", (event) => {
    event.preventDefault(); const active = client; if (!active || busy || recovery) return;
    const prompt = input("#prompt").value.trim(); if (!prompt || prompt.length > 4000) return;
    const agentId = select("#execution-mode").value === "agent" ? select("#inference-agent").value : undefined;
    if (agentId === "") { text("#inference-error", "Create an agent mandate first."); return; }
    setBusy(true); pending = null; text("#inference-error", ""); $("#open-last-receipt").hidden = true;
    for (let i = 0; i < 4; i++) step(i, "", "Waiting");
    text("#inference-output", "Your request is being prepared. The model will run only after payment is confirmed.");
    void active.prepareInference(prompt, { ...options, onStep: (state) => { if (client === active) onStep(state); }, ...(agentId ? { agentId } : {}) }).then(async (prepared) => {
      if (client !== active || life.signal.aborted) return;
      if (prepared.result) { await finish(prepared.result); setBusy(false); return; }
      pending = prepared; const required = prepared.challenge!.accepts[0]!;
      text("#payment-amount", `${units(required.maxAmountRequired)} USDC`);
      text("#payment-id", `Payment ${required.extra.paymentId}`);
      const local = canSettleLocally(prepared.health);
      text("#payment-mode-note", local ? `This uses test USDC on local chain 31337. The gateway will settle the payment, run the configured model and issue a signed receipt.${prepared.health.inferenceBackend === "echo" ? "" : " Remote provider usage can still be billed."}` : "This gateway requires an external wallet authorization. Real-network settlement is not enabled in this dashboard.");
      text("#payment-error", ""); $<HTMLButtonElement>("#confirm-payment").disabled = !local; dialog("#payment-dialog").showModal();
    }).catch((error: unknown) => { if (!life.signal.aborted && client === active) { text("#inference-error", message(error)); text("#output-status", "Request stopped"); setBusy(false); void refresh(true); } });
  });
  on("#confirm-payment", "click", () => {
    const active = client; const request = pending; if (!active || !request) return;
    $<HTMLButtonElement>("#confirm-payment").disabled = true;
    // Closing before dispatch is intentional: the main workspace shows the live execution state.
    pending = null; dialog("#payment-dialog").close(); executePrepared(active, request);
  });
  on("#retry-inference", "click", () => {
    if (!recovery || busy || client !== recovery.client) return;
    executePrepared(recovery.client, recovery.request);
  });
  on("#dismiss-recovery", "click", () => {
    if (!recovery || busy) return;
    recovery = null; $("#inference-recovery").hidden = true; text("#recovery-payment", ""); setBusy(false);
    text("#output-status", "Recovery dismissed · check payment history");
    text("#inference-error", "Check payment history before starting another request. Dismissal did not cancel or refund the previous operation.");
    void refresh(true);
  });
  on("#cancel-payment", "click", () => dialog("#payment-dialog").close());
  on("#payment-dialog", "close", () => {
    if (pending) { pending = null; setBusy(false); step(1, "", "Cancelled"); text("#output-status", "Payment not submitted"); text("#inference-output", "Payment was not submitted. No inference was started. The open payment record remains visible in your history."); void refresh(true); }
  });
  on("#open-last-receipt", "click", () => { if (lastResult) openReceipt(lastResult.typedHash); });
  on("#verify-receipt", "click", () => {
    if (!receipt || !client) return;
    const active = client, selected = receipt, version = connectionVersion, verification = ++receiptVerification;
    const current = () => !life.signal.aborted && client === active && connectionVersion === version && receipt?.typedHash === selected.typedHash && verification === receiptVerification && dialog("#receipt-dialog").open;
    text("#receipt-integrity", "Checking EIP-712 signature and domain…");
    void active.verifyReceipt(selected, options).then(() => { if (current()) text("#receipt-integrity", "Signature and typed hash verified against the connected gateway signer. Hardware attestation is a separate verification boundary."); }).catch((error: unknown) => { if (current()) text("#receipt-integrity", message(error)); });
  });
  on("#receipt-dialog", "close", () => { receiptVerification++; });
  on("#download-receipt", "click", () => { if (receipt) download(`enclave-receipt-${receipt.typedHash.slice(2, 14)}.json`, receipt); });
  on("#export-receipts", "click", () => { if (workspace) download("enclave-receipts.json", { chainId: health?.chainId, exportedAt: new Date().toISOString(), complete: !workspace.page.receiptsNext, receipts: workspace.receipts }); });
  on("#export-usage", "click", () => {
    if (!workspace) return;
    const csv = "payment,created,amount_usdc,status,settlement_tx\n" + workspace.payments.map((p) => [p.id, p.createdAt, units(p.amountUnits), p.status, p.settleTx ?? ""].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
    download("enclave-usage.csv", csv, "text/csv");
  });
  on("#new-agent", "click", () => { text("#agent-error", ""); dialog("#agent-dialog").showModal(); });
  on("#agent-form", "submit", (event) => {
    event.preventDefault(); const active = client; if (!active || !health) return;
    const button = $<HTMLButtonElement>("#agent-form button"); if (button.disabled) return; button.disabled = true; text("#agent-error", "");
    void active.createAgent({ name: input("#agent-label").value.trim(), dailyLimitUsdc: Number(input("#agent-limit").value), allowedModels: [health.servingModel.modelHash] }, options).then(async () => { dialog("#agent-dialog").close(); $<HTMLFormElement>("#agent-form").reset(); await refresh(true); notify("Agent mandate saved to the backend."); }).catch((error: unknown) => text("#agent-error", message(error))).finally(() => { button.disabled = false; });
  });
  on("#audit-form", "submit", (event) => {
    event.preventDefault(); if (!workspace) return;
    const scope = select("#audit-scope").value; const includeAmounts = input("#include-amounts").checked;
    const paymentRecords = workspace.payments.map(({ amountUnits, ...rest }) => ({ ...rest, ...(includeAmounts ? { amountUnits } : {}) }));
    download("enclave-audit.json", { exportedAt: new Date().toISOString(), purpose: input("#audit-purpose").value.trim(), scope, chainId: health?.chainId, gatewayMode: health?.teeMode, note: "Loaded owner records only. No prompt, response, session key or API key is included. Signature evidence does not establish hardware custody of the gateway.", ...(scope !== "payments" ? { receipts: workspace.receipts, moreReceiptsAvailable: Boolean(workspace.page.receiptsNext) } : {}), ...(scope !== "receipts" ? { payments: paymentRecords, morePaymentsAvailable: Boolean(workspace.page.paymentsNext) } : {}) });
    notify("Audit export downloaded.");
  });
  on("#issue-view-key", "click", () => { text("#view-key-error", ""); input("#view-key-secret").value = ""; $("#view-key-result").hidden = true; $("#view-key-form").hidden = false; dialog("#view-key-dialog").showModal(); });
  on("#view-key-form", "submit", (event) => {
    event.preventDefault(); if (!client) return;
    const button = $<HTMLButtonElement>("#confirm-view-key"); if (button.disabled) return; button.disabled = true;
    void client.issueViewKey(input("#view-key-label").value.trim(), options).then((key) => { input("#view-key-secret").value = key.secret; $("#view-key-result").hidden = false; $("#view-key-form").hidden = true; }).catch((error: unknown) => text("#view-key-error", message(error))).finally(() => { button.disabled = false; });
  });
  on("#copy-view-key", "click", () => { void navigator.clipboard.writeText(input("#view-key-secret").value).then(() => notify("View key copied. Share it only with the intended auditor.")).catch(() => text("#view-key-error", "Clipboard is unavailable. Select and copy the key field manually.")); });
  for (const kind of ["receipts", "payments", "agents"] as const) on(`#load-more-${kind}`, "click", () => {
    const active = client; if (!active || !workspace || paginationBusy) return;
    const cursor = workspace.page[`${kind}Next`]; if (!cursor) return;
    const button = $<HTMLButtonElement>(`#load-more-${kind}`); if (button.disabled) return;
    const generation = ++historyVersion, operation = ++pageRequest;
    paginationBusy = true; $$<HTMLButtonElement>("[id^=load-more-]").forEach((item) => { item.disabled = true; });
    void active.workspace({ [`${kind}Before`]: cursor }, options).then((next) => {
      if (!workspace || client !== active || life.signal.aborted || generation !== historyVersion) return;
      if (kind === "receipts") workspace.receipts = [...new Map([...workspace.receipts, ...next.receipts].map((row) => [row.id, row])).values()];
      if (kind === "payments") workspace.payments = [...new Map([...workspace.payments, ...next.payments].map((row) => [row.id, row])).values()];
      if (kind === "agents") workspace.agents = [...new Map([...workspace.agents, ...next.agents].map((row) => [row.id, row])).values()];
      workspace.page[`${kind}Next`] = next.page[`${kind}Next`]; historyExpanded = true; renderWorkspace();
    }).catch((error: unknown) => { if (!life.signal.aborted && client === active && generation === historyVersion) notify(message(error)); }).finally(() => {
      if (operation === pageRequest && !life.signal.aborted) { paginationBusy = false; $$<HTMLButtonElement>("[id^=load-more-]").forEach((item) => { item.disabled = false; }); }
    });
  });
  const timer = setInterval(() => { if (!document.hidden && client && !pending && !busy && !historyExpanded && !paginationBusy) void refresh(true); }, 5000);
  navigate(new URLSearchParams(location.search).get("view") ?? "inference");
  root.setAttribute("data-workspace-ready", "true");
  return () => { life.abort(); client?.disconnect(); clearInterval(timer); clearTimeout(toastTimer); lastResult?.outputBytes.fill(0); const secret = document.querySelector<HTMLInputElement>("#view-key-secret"); if (secret) secret.value = ""; };
}
