# Wallet login limits

Wallet authentication uses the native socket address of the client. Request `Origin` is checked separately; it is not a client identity.

For the same-host Nginx deployment, set `WALLET_AUTH_TRUSTED_PROXY_IPS=127.0.0.1,::1`. Nginx must overwrite `X-Real-IP` with `$remote_addr`, as the repository template does. Forwarding headers from other socket peers are ignored. An explicitly trusted proxy supplying a missing, invalid or multi-address `X-Real-IP` receives HTTP 503. IPv4-mapped IPv6 addresses are normalized to the corresponding IPv4 address. Hostnames, ranges and wildcard trust settings are rejected.

Run `npm run db:migrate` before installing the API change. The additive wallet migration adds `client_hash` and its index; repeated migration is supported. Previously issued challenges retain their signature scope and remain usable until expiry or consumption. The client hash isolates pending-challenge capacity; it does not restrict a correctly signed challenge to the original IP.

| Action | Requests per client per minute | Additional limit per client and resource |
| --- | ---: | --- |
| Challenge | 30 | 5 per wallet address per minute |
| Verify | 60 | 10 per challenge ID per minute |
| Resume | 120 | 60 per session token per minute |
| Logout | 60 | 30 per session token per minute |

PostgreSQL also admits at most five unconsumed, unexpired challenges for each client/address pair. This bound is protected by a transaction lock across API instances. Another client requesting the same public wallet address has separate pending capacity. The existing maximum of ten authenticated sessions per wallet is unchanged.

The production process reuses the receipt queue's Redis client for atomic quota operations. API replicas must use the same Redis service and namespace to share these quotas. Keys contain opaque hashes, have a 60-second expiry and never contain raw bearer tokens or client addresses. Redis operations have a two-second application deadline; only a ready Redis connection is used, and each API limiter permits at most 64 underlying commands pending at once. A timeout does not free its slot until the actual command settles.

If Redis is unavailable, challenge, verification and resume fail with HTTP 503. Logout retains separate capacity through a bounded local fallback. The fallback is per API instance, so it is not a distributed quota during a Redis outage. Local test instances also use bounded in-memory quotas unless a Redis limiter is injected; those quotas are per process and may evict old counters under heavy identity churn.

Clients sharing the same public IP share the per-client action limits. This change prevents one distinct client from exhausting a deployment-wide login counter; it does not establish separate identities for people behind the same NAT. Client hashes are pseudonymous operational data, not proof of a person's identity or an anonymity guarantee.

Local regressions cover the original 120-request reproduction, independent challenge/verify/resume/logout availability, forged forwarding headers, proxy normalization, logout during a limiter outage and bounded pending Redis commands. PostgreSQL tests use random private schemas, apply the migration twice and exercise legacy challenges and concurrent pending-capacity enforcement. The Redis integration cases run only with `ENCLAVE_INTEGRATION=1` and a configured disposable local `REDIS_URL`; protocol mocks do not prove execution on a real Redis engine.
