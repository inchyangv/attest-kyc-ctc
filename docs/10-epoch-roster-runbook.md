# Epoch roster runbook: publishing Mode B on chain

> 2026-09-01 · Tech Lead
> Tooling: [`script/publish-epoch.ts`](../script/publish-epoch.ts)
> Tree: [`pipeline/roster.ts`](../pipeline/roster.ts) and its Solidity twin [`src/lib/RosterProof.sol`](../src/lib/RosterProof.sol)
> Contracts: `ComplianceSource.publishEpoch` on Sepolia · `ProofmarkASC._onEpoch` and `ProofmarkRegistry.verifyWithRoster` / `proveNotInRoster` on Creditcoin CC3
> Background: [`04-event-schema.md`](04-event-schema.md) section 3.4 · [`03-product-plan.md`](03-product-plan.md) section 6.3

---

## 1. What Mode B changes

Mode A carries one mark at a time. The proof is that subject X was issued at source block N, which
is a true statement about the past and says nothing about a revocation nobody submitted
cross-chain. Marks that arrive that way are `origin = Direct`.

Mode B publishes the whole active set as one sorted-key Merkle root. Membership in the root is the
mark; **absence from the root is the revocation**, and `proveNotInRoster` returns it as positive
evidence rather than as a missing record. That is the only provenance a consumer requiring
`Policy.requireRoster` can use.

Two things the roster does not do:

- It does not replace tombstones. `verifyWithRoster` checks `ASC.tombstone(subject)` first, so an
  urgent revocation still lands immediately instead of waiting for the next epoch.
- It does not rewrite the provenance of marks already materialised. A mark that arrived as `Direct`
  stays `Direct`; the roster is the set at an epoch.

## 2. Prerequisites

| | |
|---|---|
| `.env` (repository root, gitignored) | `DEPLOYER_PRIVATE_KEY`, `SOURCE_CHAIN_RPC_URL`, `CREDITCOIN_RPC_URL`, `PROOF_BUILDER_URL`, `SOURCE_CONTRACT_ADDRESS`, `ASC_CONTRACT_ADDRESS`, `EVIDENCE_HMAC_KEY` |
| Signer role | `publishEpoch` is `onlyEpochPublisher`; `setEpochPublisher` is `onlyOwner`. The script reads `owner()` and `isEpochPublisher(signer)` and grants the role itself only when the signer is the owner. It never assumes the deployer holds either |
| Sepolia ETH | one or two transactions, whichever the role state requires |
| CC3 CTC | the worker submits `execute()`; proof verification measured 386,008 gas |

Only `--publish` reads the key, and only `--publish` loads `.env`. `--dry-run` and `--check` run
with no key and no configuration at all — the RPC URLs fall back to the public endpoints — so a
reviewer can rebuild the roster from an empty directory and compare roots.

## 3. The sequence

### 3.1 Start the worker first

```sh
npm run worker
```

Its cursor starts at the current head, so an event emitted before it starts is never seen. If that
happens, restart with `WORKER_START_BLOCK=<publish block>` rather than re-publishing.

### 3.2 Rehearse

```sh
npx tsx script/publish-epoch.ts --dry-run
```

Prints the active set with a reason for every subject left out, the root, the planned calls, and the
two self-checks (`inclusion`, `non-inclusion`) run against `pipeline/roster.ts`. Sends nothing.

Read the exclusion lines before continuing. A tombstoned subject must appear there; if an address
you expect to be active is excluded, the reason is the answer, not the roster.

### 3.3 Publish

```sh
npx tsx script/publish-epoch.ts --publish
```

What it does, in order:

1. Rebuilds the roster from chain state and refuses to continue if any tombstoned or non-Active
   subject would enter it.
2. Reads `lastEpoch()` and publishes `lastEpoch() + 1`.
3. Grants `setEpochPublisher(signer, true)` **as its own transaction**, only when needed.
4. Sends `publishEpoch(epoch, root, listVersion, validUntil)` **as its own transaction**.
5. Polls `ProofmarkASC.latestEpoch()` on CC3 every 15 seconds until it reaches that epoch,
   printing elapsed time. Attestation measured 6.5 to 8.5 minutes.
6. Writes `deployments/epoch-<n>.json` and `deployments/epoch-<n>.md`.

`publishEpoch` is never batched with anything else. `ASCBase` derives `queryId` from
`(chainKey, blockHeight, txIndex)` and carries neither the action nor the log index, so a source
transaction gets exactly one `execute()`. Mixing event kinds in one transaction lets an attacker
land the cheap action first, consume the `queryId`, and seal the other events permanently.

If the wait times out, the publish transaction is still on Sepolia and still valid — only the carry
is missing. Check that the worker is running, that it started before the publish, and what
`state/worker.json` says about that transaction.

### 3.4 Verify

```sh
npx tsx script/publish-epoch.ts --check
```

View calls only. It rebuilds the roster, compares the rebuilt root with `epochRoots(latestEpoch)`,
and only then asks the deployed registry for four verdicts: `verifyWithRoster` under the pilot
policy and under the production policy for the same mark, and `proveNotInRoster` for an address
never issued to and for the revoked subject.

Before any epoch exists it exits 1 with `no epoch published yet (latestEpoch=0)`. That is the
honest answer, not a failure.

**The deployed registry, as of epoch 1.** `ProofmarkRegistry` at
`0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc` on CC3 is an earlier build: its runtime code is 4,372
bytes against 7,021 for the current one, every Mode A function is present, and `NAMESPACE()`,
`verifyWithRoster` and `proveNotInRoster` are all absent. So the contract-side roster verdicts
cannot be produced against it. `--check` asks the runtime code for those two selectors before
calling them and says so, rather than calling into a contract that does not have the function and
reporting the resulting `execution reverted` as a proof that failed — the two are
indistinguishable from the caller's side, and a missing deployment reported as a failed verdict is
the worst available answer. It then verifies the same three proofs against the root read back from
CC3 using `pipeline/roster.ts`, labels that as off-chain, records it under `offChainChecks` rather
than `checks`, and exits non-zero. A check that did not run stays unset.

`ProofmarkASC` is the current build — it has all four epoch views and it accepted epoch 1 — and
cache mode on the deployed registry is untouched: `isVerified` answers exactly as before. What is
missing is the read path against a roster root. Restoring it means deploying the current
`ProofmarkRegistry` against the same ASC and re-registering the two policies, which is a deployment
decision and not something this script does.

**Roster drift.** If the rebuilt root differs from the on-chain root, the script prints both and
exits without printing any verdict. The active set changed after the epoch was published — a mark
was issued, revoked or expired since — so proofs built from the new tree cannot verify against the
old root, and verdicts against a root that is not ours would mean nothing. The remedy is to publish
a fresh epoch. Never edit the roster to match; `deployments/epoch-<n>.json` keeps the entries as
they were published, so the old tree can be regenerated exactly.

### 3.5 Publish the measurements

`deployments/epoch-<n>.md` is generated from that run only and contains no placeholder. Paste it:

- the section 8 bullet replaces **“Epoch rosters (Mode B) are built but not published on chain.”**
- the section 6 row goes into the cross-chain propagation table.

Then redeploy the web app so `/onchain` shows the epoch:

```sh
cd web && vercel --prod --scope stabled-ai
```

The CLI's default scope is a different team, so `--scope stabled-ai` is required.

## 4. `validUntil` is a demo parameter

`EPOCH_VALID_DAYS` (default 60) sets `validUntil = now + days`. The window is stretched so the
roster is still fresh for anyone reading the submission after the 2026-09-13 judging deadline. It is
not a claim about publication cadence: in production the cadence would be daily, so the roster
window matches the revocation SLA rather than a review period.

The trade-off is real in both directions. A long window means a revocation that is expressed only
as absence waits for the next epoch (tombstones do not wait). A short window means the roster
expires between publications — and an expired roster verifies nobody: once `validUntil` passes,
`ASC.isRosterFresh()` is false and `verifyWithRoster` fails closed for every subject. There is no
"unknown means allowed" path in either direction.

`EPOCH_LIST_VERSION` (default 1) records which screening-list set the roster was built against. It
is carried as an indexed topic so a consumer can tell two epochs apart by more than their number.

## 5. Why the source scan is defensive

The roster is built from the latest `MarkIssued` per subject on Sepolia, filtered by what the ASC on
CC3 still holds Active, untombstoned and unexpired. Getting that set wrong in the *missing*
direction is not a cosmetic bug: a mark absent from the roster reads as revoked.

The default public Sepolia endpoint is load balanced across backends that do not agree. Measured on
2026-09-01, one request for a 15,000-block range returned one of the four logs the same endpoint
returned for a 1,000-block sub-range inside it, and an address-plus-topic query returned none of the
logs the identical address-only query returned. So the script:

- filters by address only and matches the event signature client-side, the way the worker does;
- sweeps the range twice per attempt, once in 500-block chunks and once in 50,000-block windows, and
  unions the results — a union can only be too complete, and a surplus candidate is removed by the
  ASC filters afterwards;
- enumerates `MarkMaterialized` and `MarkTombstoned` on CC3 first and treats that subject set as the
  completeness oracle. The ASC cannot know a subject that was never issued on the source chain, so
  anything it knows and the scan never saw means the log query lost it. The scan repeats until the
  two agree and **exits 1 rather than publishing a partial view**;
- takes the oldest source block height out of those CC3 events as a hard floor for where the scan
  must start, alongside the `eth_getCode` creation-block binary search (which needs archive state
  the public endpoint prunes) and the oldest contract log this repository has observed.

`SOURCE_FROM_BLOCK`, `SOURCE_SCAN_CHUNK`, `SOURCE_SCAN_ATTEMPTS`, `HUB_LOG_WINDOW` and
`RPC_ATTEMPTS` override the defaults; `--help` lists all of them.

## 6. Reading `deployments/epoch-<n>.json`

| Field | |
|---|---|
| `epoch`, `root`, `listVersion`, `validUntil` | exactly what `publishEpoch` was given |
| `entries` | the full roster as published: subject, attrs, claims root, evidence hash, issuer. Enough to regenerate the tree byte for byte after drift |
| `excluded` | every subject left out, with the reason |
| `publishEpochTx`, `setEpochPublisherTx` | Sepolia transaction hashes, the latter null when the role was already held |
| `sepoliaConfirmedAt`, `cc3AcceptedAt`, `propagationSeconds`, `propagationMethod` | the propagation measurement and how it was taken |
| `checks` | the four registry verdicts with the expected value beside the actual one |

No private key or personal data reaches this file. Roster entries are commitments and packed
scalars; the two 32-byte hashes are the same commitments the mark already carries on chain.
