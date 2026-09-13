# Runtime key separation and bounded rotation

Working-tree implementation, 2026-09-07. This is the locally executable part of T-23. It does not record a production key ceremony, managed KMS/HSM custody, multisig approval, cloud access-log review or deployment.

## Counterexample and token rotation

`PM-T23-01` starts from the previous browser-flow design: AES-GCM token material was derived from `EVIDENCE_HMAC_KEY`. A holder of that evidence pseudonymization key could decrypt a wallet token, and changing the single key immediately invalidated every in-flight wallet, ID and bank step. The regression was added first and failed **0/1** because the evidence key successfully decrypted the token.

Browser-flow tokens now require independent `SERVER_TOKEN_KEY` and `SERVER_TOKEN_KEY_ID` settings. The key ID is carried in a `pm1` envelope and authenticated as AES-256-GCM additional data. The runtime refuses an explicit token-key collision with the evidence, vault or issuance-journal secret. There is no evidence-key fallback and no unversioned-token fallback.

Rotation is deliberately asymmetric:

- every new token and one-won challenge digest uses the current key;
- exactly one previous key can be configured with a distinct ID and an exact Unix-millisecond acceptance deadline;
- an in-flight token and its challenge digest remain valid only through that deadline;
- removing the complete previous-key triplet retires it immediately; old tokens and digests then fail while current tokens continue;
- partial, malformed, same-ID or same-secret rotation settings fail closed.

`/api/kyc/status` reports the non-secret current/previous key IDs and deadline so a rollout can be checked without exposing key material. This is configuration observation, not proof that old bytes were destroyed in a secret manager or removed from every process.

The existing vault rotation remains a separate atomic boundary. `vault:recovery -- rotate-key --execute` re-encrypts the authoritative envelope under a writer fence, records previous/next derived key IDs plus the opaque custodian label inside the encrypted maintenance history, preserves the records, invalidates old review revisions and rejects the old key. Old backups are intentionally not rewritten; off-host backup rotation/destruction still needs an approved custody process.

## Transaction roles

The testnet deployment preflight now requires distinct public principals for deployer, governance owner, source issuer, source rescreener, epoch publisher, worker payer, asset owner, denial-correction approver and both asset-recovery roles. Invalid, zero or repeated addresses stop before a transaction. The deployer pays only contract-creation transactions. New Source/ASC ownership is assigned to the explicit governance owner, policies are registered by that owner, and the asset contract is owned/configured by the explicit asset owner. Source issuer, rescreener and publisher grants use their dedicated addresses. The deployment record contains these public role bindings. The current source contract's issuer role authorizes both issuance and revocation, so separating issuer/rescreener EOAs isolates nonce/custody but does not create granular on-chain capabilities; resolving that product/contract authority boundary remains tied to T-06/T-12 rather than being claimed complete here.

Publisher, rescreen and worker processes additionally derive the address of the supplied private key and compare it to `EPOCH_PUBLISHER_ADDRESS`, `RESCREEN_SIGNER_ADDRESS` or `WORKER_SIGNER_ADDRESS` before operational RPC work. The demo issuance helper now uses `ISSUER_PRIVATE_KEY`, not the deployer key. These checks prevent an accidental wrong-role key from silently becoming the runtime principal; they do not turn environment-held test keys into managed production custody.

## Minimum worker environment and host boundary

`deploy/worker/sync.sh` no longer uploads the repository `.env`. It requires a separate mode-0600, regular, non-symlink worker environment file. The validator runs before SSH and accepts only the worker's RPC, contract, signer, scan/state and loopback-health settings. Missing required names, duplicates, malformed lines, files over 64 KiB, group/world permission bits and every unrelated key name—including `DEPLOYER_PRIVATE_KEY`—are rejected with fixed codes that do not reflect values.

The systemd unit uses a 0077 umask, no new privileges, private `/tmp`, read-only system paths with only `/opt/proofmark/state` writable, empty capability bounds and kernel/control-group protections. The worker health listener remains GET-only on exact loopback authority and has no admin action. The web now declares CSP, frame denial, no-sniff, no-referrer, same-origin resource/opener policy, a restrictive permissions policy and HSTS. Application error/body redaction remains covered by [the public diagnostic boundary](41-public-diagnostic-boundary.md).

## Verification boundary and remaining work

The permanent regressions cover repeated transaction-role principals, a broad worker environment containing a deployer secret, private-file enforcement, evidence-key token decryption, bounded old-token/challenge validation, explicit retirement and browser security headers. The existing publisher recovery, worker crash, vault recovery and browser/Redis/vault/two-EVM integrations exercise the connected local paths with synthetic keys and isolated services.

The final local run passed Solidity **118/118**, root TypeScript **530/530**, API **59/59**, ID image build **1/1**, epoch publication **2/2**, vault recovery **1/1**, worker crash **1/1**, and browser/HTTP/Redis/vault/two-EVM issuance **1/1**. Root typecheck, web lint/build (13 routes), shell syntax and diff checks also passed. The source-bound report recorded Solidity **118/118** and TypeScript/ABI **546/546**, with no failures, skips, cancellations or todos, at `artifacts/test-evidence/run-9CzF37/report.json`, fingerprint `910d01e1486808424fb08de9434d08321ec5b259dc974fc821a63212f58b8f99`.

Still required from authorized operators: choose and provision KMS/HSM or appropriate multisigs for every production role; establish separate accounts/projects, IAM and quorum/timelock rules; approve rotation/compromise/runbook intervals; inventory and destroy retired key copies and old backups; retain and independently review cloud KMS, secret-manager, SSH, CI and deployment access logs; test fleet-wide atomic configuration rollout/rollback; fund and deploy the approved release; and reconcile the resulting public role/ownership events. T-06, T-12, T-17 and T-21 decisions remain prerequisites. None of those conditions is completed by local green tests.
