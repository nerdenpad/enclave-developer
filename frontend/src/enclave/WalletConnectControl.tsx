import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { connectBrowserWallet, connectWalletConnect, type WalletAccount, type WalletConnection } from "./wallet-session";
import { connectionNetworks, discoverWallets, fetchWalletDirectory, networkName, pairingLink, walletError, walletProjectId, type BrowserWallet, type ListedWallet } from "./wallets";
import "./wallet.css";
import arc from "./arc-mainnet.json";

export function WalletConnectControl() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [wallets, setWallets] = useState<BrowserWallet[]>([]);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uri, setUri] = useState("");
  const [qr, setQr] = useState("");
  const [selected, setSelected] = useState<ListedWallet | null>(null);
  const [chainId, setChainId] = useState(arc.chainId);
  const [switching, setSwitching] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [directory, setDirectory] = useState<ListedWallet[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const attempt = useRef<AbortController | null>(null);
  const connection = useRef<WalletConnection | null>(null);
  const revision = useRef(0);
  const discovery = useRef<(() => void) | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setTarget(document.getElementById("wallet-connect-root"));
    return () => {
      alive.current = false; revision.current++; attempt.current?.abort(); discovery.current?.();
      discovery.current = null;
      void connection.current?.disconnect().catch(() => {});
      connection.current = null;
    };
  }, []);
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open, target]);
  useEffect(() => {
    if (busy) dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [busy]);
  useEffect(() => {
    if (!open || !walletProjectId || busy) return;
    const controller = new AbortController();
    setLoading(true); setDirectoryError("");
    const timer = setTimeout(() => {
      void fetchWalletDirectory(walletProjectId, chainId, search, page, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        setDirectory(previous => [...new Map([...(page === 1 ? [] : previous), ...result.wallets].map(wallet => [wallet.id, wallet])).values()]);
        setTotal(result.total);
      }).catch(() => {
        if (!controller.signal.aborted) setDirectoryError("The wallet list could not be loaded. You can still use the QR connection.");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, chainId, search, page, busy]);
  useEffect(() => {
    let active = true;
    setQr("");
    if (uri) void import("qrcode").then(module => module.toDataURL(uri, { width: 256, margin: 3, errorCorrectionLevel: "M" }))
      .then(value => { if (active) setQr(value); })
      .catch(() => { if (active) setError("Could not draw the QR code. Copy the connection link instead."); });
    return () => { active = false; };
  }, [uri]);

  function close() {
    if (attempt.current) { revision.current++; attempt.current.abort(); attempt.current = null; }
    setBusy(false); setUri(""); setQr(""); setSelected(null); setOpen(false);
    dialog.current?.close(); trigger.current?.focus();
  }
  function show() {
    setError(""); setNotice(""); setOpen(true);
    discovery.current ??= discoverWallets(window, setWallets);
  }
  async function connect(wallet: BrowserWallet | ListedWallet | null) {
    if (busy) return;
    const current = ++revision.current;
    const controller = new AbortController(); attempt.current?.abort(); attempt.current = controller;
    setBusy(true); setError(""); setNotice("");
    const browser = wallet && "provider" in wallet ? wallet : null;
    setSelected(wallet && !browser ? wallet as ListedWallet : null);
    const changed = (value: WalletAccount | null) => {
      if (!alive.current || current !== revision.current) return;
      setAccount(value);
      if (!value) { connection.current = null; setNotice("Wallet disconnected. Connect again to continue."); }
    };
    try {
      const result = browser ? await connectBrowserWallet(browser, controller.signal, changed)
        : await connectWalletConnect(walletProjectId, chainId, controller.signal, value => {
          if (alive.current && current === revision.current) setUri(value);
        }, changed);
      if (!alive.current || controller.signal.aborted || current !== revision.current) { await result.disconnect(); return; }
      connection.current = result;
      setAccount(result.account); setOpen(false); setUri(""); setQr("");
      dialog.current?.close(); trigger.current?.focus();
      setNotice("Wallet connected. Real USDC payments are not enabled yet.");
    } catch (failure) {
      if (alive.current && current === revision.current) { setError(walletError(failure)); setUri(""); setSelected(null); }
    } finally { if (alive.current && current === revision.current) { setBusy(false); attempt.current = null; } }
  }
  async function disconnect() {
    revision.current++; attempt.current?.abort();
    const previous = connection.current; connection.current = null;
    setAccount(null); setBusy(false);
    setNotice("Wallet disconnected from Enclave.");
    try { await previous?.disconnect(); }
    catch { setNotice("Disconnected here. Remove the Enclave session in your wallet if it is still listed."); }
  }
  async function copyUri() {
    try { await navigator.clipboard.writeText(uri); setNotice("Connection link copied. Paste it only into your wallet."); }
    catch { setError("Clipboard access is unavailable. Scan the QR code instead."); }
  }
  async function switchNetwork() {
    const selectedConnection = connection.current;
    if (!selectedConnection?.switchToArc || switching) return;
    setSwitching(true); setNotice("Approve the switch to Arc Mainnet in your wallet.");
    try {
      await selectedConnection.switchToArc();
      if (alive.current && connection.current === selectedConnection) setNotice("Connected to Arc Mainnet. Real USDC payments are not enabled yet.");
    } catch {
      if (alive.current && connection.current === selectedConnection) setNotice("The network switch was not completed. You can try again from your wallet.");
    } finally { if (alive.current) setSwitching(false); }
  }
  if (!target) return null;
  const mobileLink = selected ? pairingLink(selected, uri) : null;
  const visibleWallets = wallets.filter(wallet => wallet.name.toLowerCase().includes(search.toLowerCase()));
  return createPortal(<>
    <div className="wallet-control">
      <div className="wallet-control-actions">
        <button type="button" className="wallet-trigger" ref={trigger} onClick={show} aria-haspopup="dialog" aria-expanded={open}>
          {account ? `${account.address.slice(0, 6)}…${account.address.slice(-4)}` : "Connect wallet"}
        </button>
        {account && <button type="button" className="wallet-secondary" onClick={() => void disconnect()}>Disconnect wallet</button>}
        {account && account.chainId !== arc.chainId && account.transport === "browser" && <button type="button" className="wallet-secondary" disabled={switching} onClick={() => void switchNetwork()}>{switching ? "Switching to Arc…" : "Switch to Arc"}</button>}
      </div>
      {account && <span className="wallet-network">{account.name} · {networkName(account.chainId)}</span>}
      <span className="wallet-note">USDC on Arc · Payments not enabled yet</span>
      <span className="wallet-notice" role="status">{notice}</span>
    </div>
    <dialog className="wallet-dialog" data-react-controlled ref={dialog} aria-labelledby="wallet-dialog-title" aria-describedby="wallet-dialog-description"
      onCancel={event => { event.preventDefault(); close(); }}
      onClick={event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) close();
      }}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)')].filter(element => element.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="wallet-dialog-heading"><h2 id="wallet-dialog-title">{account ? "Connected wallet" : "Connect your wallet"}</h2><button type="button" className="wallet-secondary" onClick={close} aria-label="Close wallet dialog">Close</button></div>
      <p id="wallet-dialog-description" className="wallet-note">Choose a wallet to share your address. Connecting does not sign a payment or give Enclave access to your funds.</p>
      {account ? <div className="wallet-account"><span>{account.name} · {networkName(account.chainId)}</span><code>{account.address}</code><p>Real USDC payments are not enabled on this deployment.</p><button type="button" className="wallet-trigger" onClick={() => { void disconnect(); close(); }}>Disconnect wallet</button></div> : <>
        {!busy && <>
          <label className="wallet-label" htmlFor="wallet-search">Search wallets</label>
          <input id="wallet-search" className="wallet-input" type="search" autoComplete="off" maxLength={80} value={search} onChange={event => { setSearch(event.target.value); setPage(1); setDirectory([]); setTotal(0); }} />
          <h3>Browser wallets</h3>
          {visibleWallets.length ? <div className="wallet-list">{visibleWallets.map(wallet => <button className="wallet-choice" type="button" key={wallet.id} onClick={() => void connect(wallet)}><span>{wallet.name}</span><small>Browser extension</small></button>)}</div> : <p className="wallet-note">{wallets.length ? "No browser wallets match your search." : "No browser wallet detected. Unlock an installed wallet or connect with a QR code."}</p>}
          <h3>WalletConnect</h3>
          {walletProjectId ? <>
            <label className="wallet-label" htmlFor="wallet-network">Connection network</label>
            <select id="wallet-network" className="wallet-input" value={chainId} onChange={event => { setChainId(Number(event.target.value)); setPage(1); setDirectory([]); setTotal(0); }}>{connectionNetworks.map(network => <option key={network.id} value={network.id}>{network.name}</option>)}</select>
            <p className="wallet-note">Arc Mainnet is the selected payment network. Connecting does not enable payments; settlement is still being prepared.</p>
            <button type="button" className="wallet-qr-button" onClick={() => void connect(null)}>Connect with QR code</button>
            <p className="wallet-note" role="status">{loading ? "Loading wallets…" : directoryError || `${directory.length} wallets loaded${total ? ` · ${total} directory results` : ""}`}</p>
            <div className="wallet-list">{directory.map(wallet => <button className="wallet-choice" type="button" key={wallet.id} onClick={() => void connect(wallet)}><span>{wallet.name}</span><small>WalletConnect</small></button>)}</div>
            {directory.length < total && !directoryError && <button className="wallet-secondary" type="button" disabled={loading} onClick={() => setPage(value => value + 1)}>Load more wallets</button>}
            {directoryError && <button className="wallet-secondary" type="button" onClick={() => { setPage(1); setSearch(""); setOpen(false); requestAnimationFrame(show); }}>Reload wallet list</button>}
          </> : <p className="wallet-note">Mobile connections and the full wallet directory are not available on this deployment yet. You can connect an installed browser wallet above.</p>}
        </>}
        {busy && <div className="wallet-pairing">
          <p role="status">{uri ? `Scan with ${selected?.name ?? "your wallet"} and approve the connection.` : "Approve the connection in your wallet…"}</p>
          {qr && <img src={qr} alt="WalletConnect pairing QR code" width="256" height="256" />}
          {uri && <button className="wallet-secondary" type="button" onClick={() => void copyUri()}>Copy connection link</button>}
          {mobileLink && <a className="wallet-trigger" href={mobileLink} rel="noreferrer">Open {selected?.name}</a>}
          <p className="wallet-note">Only share this connection link with your wallet. No payment is requested.</p>
          <button className="wallet-secondary" type="button" onClick={close}>Cancel connection</button>
          <p className="wallet-note" role="status">{notice}</p>
        </div>}
      </>}
      <p className="wallet-error" role="alert">{error}</p>
    </dialog>
  </>, target);
}
