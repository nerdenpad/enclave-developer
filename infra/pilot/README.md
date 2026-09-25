# Single-server pilot

This deployment runs the built website, API, receipt worker, PostgreSQL, Redis
and an isolated development chain on one Debian 12 x86-64 VPS. NEAR remains the
remote inference provider. The VPS is not a confidential VM. Gateway keys are
held in software; settlement uses MockUSDC on Anvil 31337. This is not an E1
production release.

The initial host has 8 vCPUs, 16 GB RAM and a 222 GB root filesystem. There are
no GPUs on this host. A single host is not highly available.

## Initial setup

1. Inspect the host before changing it. `install-host.sh` is for a fresh Debian
   12 machine; it installs Docker from its official repository, Node 22 from
   its official distribution with a SHA-256 check, nginx and isolated Certbot.
2. Put the source checkout in `/opt/enclave`, owned by the `enclave` system
   account. Do not upload developer `node_modules`, existing database volumes,
   local CVM signer state, `.git`, or unrelated environment files.
3. Run `npm ci` separately in `_backend` and `frontend`. Create the Python venv
   at `_backend/infra/near/.venv` and install its pinned `requirements.txt`.
4. Privately provision `_backend/.env.near` with the selected NEAR credential,
   model, direct endpoint, Linux verifier path and reviewed policy path.
   Set permissions to `0600`; never put credentials in a frontend build.
5. Build with `npm run build:node` and run `npm run typecheck`. As root, run
   `bash infra/pilot/publish-assets.sh` after each build, before switching the
   web release. For a staged build, pass its absolute `public/assets` directory.
   nginx serves compressed public assets directly; retain previous hashed files
   for open tabs and rollback. Never copy environment files into this directory.
6. From `_backend`, bootstrap this fresh, private development environment using
   `node --import tsx scripts/prepare-demo.ts --near-env .env.near`. Docker
   access is required. This command refuses to overwrite unmanaged state.
   Give `enclave` ownership of `.env.demo`, `data` and `work` afterward.
7. Install the `enclave-*.service` and `enclave-*.timer` files into
   `/etc/systemd/system`. Enable/start `enclave-infra`, `enclave-api` and
   `enclave-web`. Wait for `http://127.0.0.1:8789/health`, then run
   `node --import tsx scripts/prepare-demo.ts --register` once and start
   `enclave-worker`.
8. As `enclave`, provision a separate non-administrator pilot key:
   `node --env-file=.env.demo --import tsx scripts/provision-pilot-client.ts`.
   The private key is saved in `data/demo/pilot-client.env`. It has a daily
   allowance of 1 test USDC (10 successful calls at the default 0.10 price).
   This is an application allowance, not a NEAR billing cap. NEAR may bill
   failed/uncertain inference attempts too. Keep the bootstrap admin key private.
9. Issue the HTTPS certificate using a webroot at `/var/www/enclave-acme`.
   Replace `__HOST__` in `nginx.conf.template` with the reviewed IP/domain;
   use that certificate's exact directory. Test with `nginx -t` before reload.
   Enable `enclave-cert-renew.timer` and verify renewal. IP certificates need
   the ACME `shortlived` profile and Certbot's `--ip-address` flag.

Only ports 22, 80 and 443 should be reachable externally. API, website upstream,
PostgreSQL, Redis and Anvil bind to loopback. Never publish the Anvil RPC port:
it supports development-only account and chain-control methods.

The API runs with `NODE_ENV=development` and the existing production guard.
The website is a built Node server, not a public Vite development server.
nginx provides HTTPS, same-origin `/api`, request/body/connection limits and
no-store responses. Inference requires a private client API key held only in
browser memory. Optional public wallet sign-in is available after migration and
`WALLET_AUTH_ORIGIN=https://enclaveagent.tech` configuration; it opens a private,
read-only pilot workspace and does not grant inference credit or real checkout.
See [wallet sign-in](../../docs/wallet-payments.md).

## Acceptance

`node frontend/scripts/check-wallet-login.mjs` checks the published wallet login
using a fresh, unfunded EOA fixture. It verifies signature login, empty owner
history, no browser credential storage, blocked pilot spending and revocation
after an account change. It creates no chain transaction or inference request.
This fixture does not replace approval testing in actual wallet applications.

Run `npm run test:pilot` with `PILOT_URL` set to the HTTPS origin. It verifies
the home/dashboard/verify/status pages, trusted TLS, browser cryptography and
unauthenticated workspace rejection. Load the private `PILOT_API_KEY` through
an ignored environment file to also check authenticated access.

Pass `--run-inference` explicitly for one paid NEAR request. The check uses a
generic prompt, confirms the test-payment dialog, verifies the browser receipt
and waits for its development-chain anchor. It never retries inference.
Metadata and screenshots are written under ignored `frontend/test-results/pilot`.

Repeat acceptance after a service restart and verify receipt history persists.
Use `systemctl is-enabled` to check boot startup and certificate renewal.
Renewal checks must not disable TLS validation.

## Operations and migration

- Services: `enclave-infra`, `enclave-api`, `enclave-worker`, `enclave-web`.
- Infrastructure volumes remain owned by compose project `enclave-full-demo`.
  Stop services with systemd. Never use `docker compose down -v` for updates.
- Preserve the database, Redis queue, Anvil state, `.env.demo`, and
  `data/demo/cvm.json` as a consistent deployment. Restoring only the database
  or creating replacement signer keys can invalidate history.
- An encrypted off-host backup needs a separately configured destination.
  Same-server copies alone are not a disaster-recovery solution.
- Monitor the reviewed NEAR policy's `validUntil`. Expired or changed evidence
  must reject requests; do not extend trust automatically or disable checks.
- Domain changes require DNS A records to the VPS and a new certificate/nginx
  configuration. They do not require moving application data.
- Moving to Phala requires a hardware adapter and attestation-bound key
  release, an explicit signer transition, and acceptance of the deployed path.
  A larger GPU or a new hostname does not establish those guarantees.
