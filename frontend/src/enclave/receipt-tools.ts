import arc from "./arc-mainnet.json";
import type { WorkspaceReceipt } from "./api";

export function arcTransactionUrl(receipt: Pick<WorkspaceReceipt, "chainId" | "status" | "anchoredTx">): string | null {
  if (receipt.chainId !== 5042 || receipt.status !== "anchored" || !/^0x[0-9a-fA-F]{64}$/.test(receipt.anchoredTx ?? "")) return null;
  return `${arc.explorerUrl}/tx/${receipt.anchoredTx}`;
}

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function receiptsCsv(receipts: WorkspaceReceipt[]): string {
  const columns = ["id", "created_at", "receipt_hash", "model_hash", "code_hash", "input_hash", "output_hash", "attestation_ref", "chain_id", "verifier_address", "status", "anchor_tx", "timestamp", "signature"];
  const rows = receipts.map(r => [r.id, r.createdAt, r.typedHash, r.modelHash, r.codeHash, r.inHash, r.outHash, r.attRef, r.chainId, r.verifierAddress, r.status, r.anchoredTx, r.ts, r.sig]);
  return [columns, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
