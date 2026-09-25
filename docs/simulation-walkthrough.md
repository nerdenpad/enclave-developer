# Development simulation recording

This walkthrough demonstrates encrypted requests, explicit test-payment approval,
signed receipts, local anchoring and persistent history. It does not demonstrate
GPU inference, hardware attestation, Arc settlement or real-USDC payments.

The simulation uses the existing Echo fixture, which returns binary test output,
and the local Anvil deployment. API responses and transaction records are produced
by the running services; the recorder does not insert success responses.

## Run

With dependencies installed and Docker available:

```sh
npm run demo:simulate
```

This starts the three project development containers and local API, worker and
frontend. Existing demo data is preserved and checked before startup. The Echo
override applies only to these processes; the saved NEAR profile and public
deployment are unchanged. The local Echo model is registered if necessary.

In a second terminal:

```sh
npm run demo:record:simulation
```

The recorder checks for Echo, development mode, mock payments and chain 31337
before submitting a request. It confirms one local test payment, checks the
completed response and receipt signature, waits for anchoring, downloads the
receipt and verifies that the request count survives a reload. A failed run
does not produce an MP4.

Output is saved under `frontend/recordings/simulation-<timestamp>/`:

- `Enclave-Simulation.mp4`: English captions and a permanent simulation label.
- `simulation-receipt.json`: the actual local receipt.
- `verification.json`: HTTP status evidence and checks, with no credentials.
- Screenshots and publication notes.

Keep the simulation label visible when sharing. A successful local receipt
signature proves software signing in this environment, not hardware execution.
This recording is separate from the live-provider recorder and its export gates.

Stop the launcher with Ctrl+C, then run `npm run demo:stop` to stop its three
containers without deleting their data. Use `npm run dev` to return to the saved
provider configuration.
