# Bank challenge state and deposit idempotency

2026-09-07 implementation and re-verification record for T-04, with part of T-22. Local verification is complete; deployment and shared-store provisioning have not been performed.

## What changed

The browser no longer owns an `attempts` counter. The sealed challenge carries a random challenge ID and an opaque request key, bound to the consented wallet flow. A shared state transition verifies the active challenge, original expiry, failure count and consumption before returning a bank proof. Five incorrect codes lock that challenge; even the correct code then fails. Concurrent successes have one winner. Issuing a replacement challenge in the same flow invalidates the previous one. Old tokens lacking the new identifiers are rejected.

The Redis adapter executes the same Lua operation on one authoritative primary for every app instance. It uses Redis time for expiry and counters. This avoids separate application-side read/update races. See [Redis's script execution semantics](https://redis.io/docs/latest/develop/programmability/eval-intro/). Commands use authenticated JSON POST with no redirects, cache or automatic mutation retries, following the [Redis REST API contract](https://upstash.com/docs/redis/features/restapi).

## Deposit boundary and budgets

The API reserves a request and charges its budgets **before** holder lookup or one-won transfer. `startRequestId` identifies a deliberate start attempt. Retrying it with the same payload returns the originally encrypted response without calling the vendor again; changed payload under an explicit ID conflicts. A pending request is not automatically retried. A timeout may mean the bank already sent the deposit, so an operator must reconcile an ambiguous vendor result before another deliberate send. This implementation does not claim a vendor-side transaction lookup or exactly-once external transfer protocol.

For older callers that omit `startRequestId`, the default is bound to flow + bank + account. The UI generates an explicit ID and retains it across a request retry. It resets the ID only when the input changes or a challenge is explicitly restarted after terminal rejection. Page-reload recovery of the same start ID remains part of T-24.

The subsequent [T-22 transport change](40-vendor-http-boundaries.md) removes the connectors' internal 401 POST replay and adds header/body deadlines and response limits. An actual-connector/synthetic-fetch API regression keeps a timed-out deposit pending and proves the same request makes no second product call. An expired 24-hour record, new start ID or cleared store still cannot be treated as evidence that the first deposit did not occur.

Default limits in `pipeline/bank-state.ts`:

| Scope | Limit | Window |
|---|---:|---|
| Incorrect challenge codes | 5 | Original 10-minute challenge |
| Deposit-start reservations per flow | 3 | 24 hours |
| Reservations per keyed bank/account | 3 | 24 hours |
| Reservations per wallet | 5 | 24 hours |
| All reservations in the deployment namespace | 1,000 | 24 hours |

Failed/ambiguous vendor operations still consume budget; replay does not refund it. Windows start with the first reservation and do not slide on retries. All quota keys use one Redis hash tag to make the multi-key operation atomic. The global cap protects the pilot's send budget, but also exposes a deliberate availability tradeoff: an attacker can exhaust it. Adaptive abuse controls, operator alerts and economic limits remain T-22. Per-IP request guards are not the bank-challenge security boundary.

## Deployment configuration

Set server-only `BANK_STATE_REDIS_REST_URL`, `BANK_STATE_REDIS_REST_TOKEN` and `BANK_STATE_NAMESPACE`. All app instances for one deployment must share the same namespace, primary and HMAC key. Use a separate namespace/database and secrets for production and test. The endpoint must be HTTPS without embedded credentials or token query parameters. Tokens are sent only in the authorization header.

Any external bank rail—including an external testbed—requires Redis configuration before the first vendor call. Missing/partial configuration, HTTP errors, malformed responses and timeouts fail closed. No Redis error falls back to memory. Status/UI expose the configured mode, not credentials or a claim of store availability. Provision a private, no-eviction, durable store with restricted command/key permissions, monitoring and a tested failover policy; stale failover or a restored snapshot can roll back counters and therefore must invalidate in-flight challenges. The integration tests do not establish a provider's failover durability.

Only `KYC_DEMO=1` with the built-in `demo:bank` can use the explicitly labelled `demo-memory` adapter. Losing that instance loses the challenge and rejects its token; it never re-creates a count from client data. Demo budgets are per instance and are not a distributed financial safeguard. This mode makes no real deposit and must not be used for external banks.

## Privacy and retention

Keys are domain-separated HMAC digests of wallet, flow, bank/account and payload values. Redis does not receive their cleartext. The cached result is an AES-GCM sealed token containing the original response, with its original expiry. The bank challenge no longer carries the account number. The raw authentication code is not stored as plaintext in Redis. The synthetic demo still displays its code intentionally.

Consumed/locked records lose the cached response. Other challenge/idempotency metadata and keyed quotas expire after 24 hours; challenge use expires after ten minutes regardless of record retention. HMAC identifiers remain linkable, pseudonymous data. Limit access and backups accordingly; rotating the HMAC key or namespace during an active window also resets its quota namespace and must be treated as a controlled migration.

## Verification and remaining gates

```sh
npx tsx --test pipeline/bank-state.test.ts
npm run test:bank-redis
npm --prefix web run test:api
```

The exact appendix-B counterexample now has a route-level regression that submits the same pristine sealed challenge five times from distinct request origins, ignoring every returned response token. Against the isolated `HEAD` implementation it failed **0/1** because the fifth request was still `CODE_MISMATCH`; against the shared-state implementation it passes **1/1** and a subsequent correct-code replay remains locked. The complete local rerun passed **109/109** Solidity tests, **483/483** root TypeScript tests, **3/3** isolated real-Redis integration tests and **56/56** actual Next handler tests. Root typecheck and web lint/build also passed.

The Redis command creates a network-isolated, unmounted Docker container from the pinned Redis 7.4.9 image and stops only that container afterward. It executes the production Lua in real Redis; only the REST transport is substituted by `redis-cli` for local isolation. Tests use two independent store objects, twenty concurrent wrong attempts, ten concurrent successes/reservations, cached-response recovery, payload conflicts, expiry/supersession and cross-instance account budgets. Unit tests cover demo-instance loss and failure/no-fallback behavior. API tests call the actual Next handler with synthetic sealed wallet flows and demo vendors; no institutional credential or chain transaction is involved.

Production REST-provider conformance, approved capacity/budgets, state-failover challenge invalidation, bank-side ambiguous-transfer reconciliation, page-reload recovery and live operational rollout remain gates. Shared-store configuration alone does not make the KYC result legally sufficient or prove that the document/account belongs to the human behind a wallet.
