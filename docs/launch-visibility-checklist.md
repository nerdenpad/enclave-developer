# Launch visibility checklist

The six public and workspace features are implemented ahead of launch. They do not turn the development gateway into production or imply GPU TEE attestation.

At deployment, publish the updated API and frontend together. The API provides `GET /v1/public/models` and `GET /v1/public/arc-receipts/count`; the frontend reads them at `/models` and `/status`. No database migration is required. The receipt count includes only rows on Arc chain 5042 whose configured verifier matches, whose anchor transaction is a valid hash, and whose worker status is `anchored`. Confirm its value against the Arc explorer before announcing it.

Before each public update, add a dated, factual entry to `frontend/src/enclave/release-updates.ts` and deploy the resulting frontend build. For launch, check `/models`, `/status`, one receipt's Arc Explorer link, JSON/CSV download, and both payment-to-receipt and receipt-to-payment navigation with a real, owner-accessible record. CSV exports the receipts currently loaded in the workspace; load older pages before exporting a full history.

The deployment and smoke test depend on release access and live Arc data. A five-to-seven-minute update window is an operational target, not a guarantee.
