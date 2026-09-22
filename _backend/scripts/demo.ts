import { config as loadDotenv } from "dotenv";
import { encryptAesGcm } from "@enclave/core";

loadDotenv();

const base = process.env.API_BASE ?? "http://127.0.0.1:8787";
const apiKey = process.env.DEMO_API_KEY ?? "enclave_dev_key";

async function json(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function paymentIdFrom402(body: unknown): string {
  const extra = (body as { details?: { accepts?: Array<{ extra?: { paymentId?: string } }> } }).details?.accepts?.[0]
    ?.extra?.paymentId;
  if (!extra) {
    throw new Error(`402 body missing paymentId: ${JSON.stringify(body)}`);
  }
  return extra;
}

async function infer(sessionId: string, blob: { iv: string; tag: string; ciphertext: string }, headers: Record<string, string>) {
  return fetch(`${base}/v1/inference`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      ...headers,
    },
    body: JSON.stringify({ sessionId, ...blob }),
  });
}

async function main() {
  const health = await fetch(`${base}/health`);
  if (!health.ok) {
    throw new Error(`API not up: ${health.status}`);
  }

  const quoteRes = await fetch(`${base}/v1/attestation/quote`);
  const quote = (await quoteRes.json()) as Record<string, unknown>;

  const sessionRes = await fetch(`${base}/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(quote),
  });
  if (!sessionRes.ok) {
    throw new Error(`session failed: ${sessionRes.status} ${await sessionRes.text()}`);
  }
  const session = (await sessionRes.json()) as { sessionId: string; wrapKey: string };
  const blob = encryptAesGcm(Buffer.from(session.wrapKey, "base64"), Buffer.from("hello from enclave demo"));
  const idempotencyKey = `demo-${Date.now()}`;

  const unpaid = await infer(session.sessionId, blob, { "idempotency-key": idempotencyKey });
  if (unpaid.status !== 402) {
    throw new Error(`expected 402, got ${unpaid.status} ${await unpaid.text()}`);
  }
  const challenge = await json(unpaid);
  const paymentId = paymentIdFrom402(challenge);

  const unpaidAgain = await infer(session.sessionId, blob, { "idempotency-key": idempotencyKey });
  if (unpaidAgain.status !== 402) {
    throw new Error(`expected reused 402, got ${unpaidAgain.status}`);
  }
  const againId = paymentIdFrom402(await json(unpaidAgain));
  if (againId !== paymentId) {
    throw new Error(`idempotent 402 opened a new payment: ${againId} vs ${paymentId}`);
  }

  const settleRes = await fetch(`${base}/v1/x402/settle`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ paymentId }),
  });
  if (!settleRes.ok) {
    throw new Error(`settle failed: ${settleRes.status} ${await settleRes.text()}`);
  }
  const settled = (await settleRes.json()) as { paymentId: string; tx: string };

  const paid = await infer(session.sessionId, blob, {
    "idempotency-key": idempotencyKey,
    "x-payment": paymentId,
  });
  if (!paid.ok) {
    throw new Error(`inference failed: ${paid.status} ${await paid.text()}`);
  }
  const inferBody = (await paid.json()) as { typedHash: string; outputHash: string };

  const replay = await infer(session.sessionId, blob, {
    "idempotency-key": idempotencyKey,
    "x-payment": paymentId,
  });
  if (!replay.ok) {
    throw new Error(`replay failed: ${replay.status} ${await replay.text()}`);
  }
  const replayBody = (await replay.json()) as { typedHash: string };
  if (replayBody.typedHash !== inferBody.typedHash) {
    throw new Error(`idempotency mismatch: ${replayBody.typedHash} vs ${inferBody.typedHash}`);
  }

  const doubleCharge = await infer(session.sessionId, blob, { "x-payment": paymentId });
  if (doubleCharge.status !== 402 && doubleCharge.status !== 409) {
    throw new Error(`expected consumed payment to 402/409, got ${doubleCharge.status} ${await doubleCharge.text()}`);
  }

  let stored = { status: "pending" };
  for (let i = 0; i < 15; i++) {
    const receiptRes = await fetch(`${base}/v1/receipts/${inferBody.typedHash}`);
    stored = (await receiptRes.json()) as { status: string };
    if (stored.status === "anchored" || stored.status === "anchored-sim") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const eventsRes = await fetch(`${base}/v1/chain/events?limit=10`);
  const events = (await eventsRes.json()) as Array<{ source: string; txHash: string }>;

  console.log(
    JSON.stringify(
      {
        quoteMeasurement: quote["measurement"],
        sessionId: session.sessionId,
        paymentId,
        settleTx: settled.tx,
        typedHash: inferBody.typedHash,
        replayTypedHash: replayBody.typedHash,
        outputHash: inferBody.outputHash,
        storedStatus: stored.status,
        chainEvents: events.map((e) => ({ source: e.source, txHash: e.txHash })),
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
