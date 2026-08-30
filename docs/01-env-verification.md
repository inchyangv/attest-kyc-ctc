# Environment verification: Attestcoin on CC3 Testnet

> Run 2026-08-30 · Purpose: clear the largest risk before starting, which was whether the development environment works at all
> Subject: `gluwa/attestcoin-protocol-examples`, Tutorial 1 `Hello Bridge`

---

## 1. Conclusion

The environment is alive and behaves as documented, and the wallet is funded. The oracle attests Sepolia continuously and the measured lag matches what the docs claim. Code, RPCs, proof builder and contracts all check out. No blockers. What remains is not funding but attestation latency, around eight minutes.

| Item | Status |
|---|---|
| Toolchain (node, yarn, foundry) | ok |
| Dependency install | ok |
| Contract compilation | ok |
| CC3 Testnet RPC | ok |
| Sepolia RPC, free public | ok |
| ChainInfo precompile query | ok |
| Oracle attestation | ok, lag around 8 minutes |
| Proof Builder API | ok |
| Deployed example contracts | ok |
| Wallet and `.env` | ok |
| Testnet funds | ok: Sepolia 0.05 ETH, CC3 **10,000 CTC** |

---

## 2. Toolchain

| Tool | Version | Note |
|---|---|---|
| Node.js | v24.15.0 | |
| yarn | 1.22.22 | via `corepack enable`, no global install needed |
| foundry (forge, cast) | **1.7.1** | The repo README suggests `foundryup --version v1.2.3`. 1.7.1 builds cleanly, so no downgrade. |
| solc | 0.8.30 | set in foundry.toml |

```
yarn install  → Done in 6.34s (exit 0)
yarn build    → Compiling 32 files with Solc 0.8.30 → Compiler run successful!
```

---

## 3. Network verification

### 3.1 Chain connectivity

| Chain | RPC | chainId | Status |
|---|---|---|---|
| Creditcoin CC3 Testnet | `https://rpc.cc3-testnet.creditcoin.network` | **102031** | ok, block 5,399,037 |
| Ethereum Sepolia | `https://ethereum-sepolia-rpc.publicnode.com` | **11155111** | ok, block 11,597,291 |

CC3 Testnet gas price: `500000000` (0.5 gwei)

### 3.2 Sepolia RPC without an Infura account

The tutorial asks for Infura. A free public RPC works instead, verified by measurement.

| Candidate | Result |
|---|---|
| `https://ethereum-sepolia-rpc.publicnode.com` | works, adopted |
| `https://1rpc.io/sepolia` | works, kept as backup |
| `https://rpc.sepolia.org` | 404, dead |
| `https://sepolia.drpc.org` | requires a paid plan |

A dedicated key from Infura or Alchemy is still the better choice for anything that has to be reliable during a demo. Public endpoints can rate limit.

### 3.3 chainKey mapping, confirmed at runtime

`PrecompileChainInfoProvider.getSupportedChains()` returns:

```json
[
  { "chainKey": 3, "chainId": 1,        "chainName": "Ethereum",         "chainEncoding": 1 },
  { "chainKey": 1, "chainId": 11155111, "chainName": "Sepolia ethereum", "chainEncoding": 1 }
]
```

> **The trap is real.** `chainKey` 1 is not `chainId` 11155111. This matches the docs and the repo `.env`. Never hardcode it; query `getSupportedChains()`.

### 3.4 Oracle attestation is running

```
chainKey 1 (Sepolia): height=11,597,250
                      hash=0x9d134405282de887dcb37add3b7581a8f61db10db2346356c11787fd08a10815
                      Sepolia head=11,597,291 → lag 41 blocks, about 8.2 minutes
chainKey 3 (Ethereum mainnet): height=25,866,490
```

**Measured lag ranges from 6.5 to 8.8 minutes across three observations**, which matches the "8 to 10 minutes" the docs quote. The margin exists to survive source chain reorgs.

> **Design consequence.** Cross-chain confirmation carries roughly eight to ten minutes of delay, and the demo UX and architecture both have to assume it: optimistic UI, a visible waiting state, an async worker. Nothing needing a real-time answer belongs on this axis.

### 3.5 Proof Builder API

| URL | `/api/v1/attested-height/1` | Note |
|---|---|---|
| `https://prover.cc3-testnet.creditcoin.network` | `{"attestedHeight":11597250}` | repo `.env` default |
| `https://proof-gen-api.cc3-testnet.creditcoin.network` | `{"attestedHeight":11597250}` | value in the official docs |

Both domains behave identically and look like aliases. Response time around 0.58s.

Endpoints, read off the SDK source:
- `GET /api/v1/attested-height/{chainKey}`, latest attested height
- `GET /api/v1/proof-by-tx/{chainKey}/{transactionHash}`, transaction proof

### 3.6 Deployed example contracts on CC3 Testnet

| Address | Kind | Check |
|---|---|---|
| `0x...0fd3` | ChainInfo precompile | call succeeds. `code` is `0x`, which is normal for a Substrate precompile |
| `0x...0FD2` | BlockProver precompile | present |
| `0x2Be9B8640ED32815d3B9e8C92AbcD3F15F07396f` | ASC Minter | bytecode present |
| `0x914Cf96BF28b7b4921db27b264ecEd71aC91134E` | Mintable Token | `Bridge Test Token` / `BTKT` / 18 decimals |
| `0x0F24FD9e0524BA53d3f0A4A40350Adf5370b4A53` | Sepolia ERC20 burner | called once funds arrived |

---

## 4. Local setup

- Clone location: `reference/attestcoin-protocol-examples/`
- Throwaway test wallet created with `cast wallet new`
  - Address: `0xFD1222e35a536A62f180aA44826656940e86bD5E`
  - The private key later moved to the project root `.env`. Key to address derivation verified.
- `.env`: `SOURCE_CHAIN_RPC_URL` set to the publicnode Sepolia endpoint, `CREDITCOIN_WALLET_PRIVATE_KEY` populated

### A security problem in the example repo

> The upstream repo has no `.env` in its `.gitignore`, and `.env` is committed. Follow the tutorial, put your private key in `.env`, fork and commit, and you have published the key.

Fixed locally:
- added `.env` and `.env.local` to `.gitignore`
- `git rm --cached .env`, confirmed with `git ls-files .env` returning nothing

> **Do not copy this pattern into our repo.** Commit `.env.example` and ignore `.env`. The wallet here is a worthless throwaway, but habits are what produce accidents.

---

## 5. Funding

Received 2026-08-30: Sepolia **0.05 ETH**, CC3 **10,000 CTC**.

> This wallet is shared. Two sessions sending from the same key collide on nonce and both break. On-chain transactions come from one session at a time. Parallel work needs a second wallet with its own faucet grant.

Faucets, for a refill:

| Funds | Where | Requires |
|---|---|---|
| Sepolia ETH | https://cloud.google.com/application/web3/faucet/ethereum/sepolia | Google account |
| CC3 Testnet CTC | Creditcoin Discord faucet channel, `/faucet address: <address>` | Discord |

### The amount received differs from the README

> **Correction.** The first draft of this document repeated the README's claim that the faucet gives 100 test CTC per 24 hours, worth nine oracle queries, and built a section of mitigations around "nine per day is a severe constraint". The actual grant was 10,000 CTC, a hundred times more. Every argument that rested on a query budget is withdrawn.

| Item | README | Measured |
|---|---|---|
| CC3 grant | 100 CTC per 24h | **10,000 CTC** |
| Queries it buys | 9 | about 50 million, at the measured 0.0002 CTC each |
| Sepolia ETH | not stated | 0.05 ETH |

Confirmed by running an end-to-end query:

| Item | Measured |
|---|---|
| CC3 `execute()` gas | **394,982** (SDK estimated 421,105, 6.6% high) |
| Gas price | 0.5 gwei |
| Balance change | 10000 to 9999.999802509 CTC |
| **Cost per query** | **0.0002 CTC** |
| Separate oracle fee | none. The deduction equals the gas cost exactly |

> **Free reads are the protocol's stated design, and the measurement agrees.**
>
> | Source | Statement |
> |---|---|
> | attestcoin.org | "Free reads, paid writes. Apps can read other chains at no cost; cross-chain actions require ATC token payment" |
> | Our measurement | The `execute()` deduction equals the gas cost exactly. No additional fee. |
>
> What costs ATC is writability, the cross-chain execution path that is still in development. Readability costs gas and nothing else. The README's "100 CTC = 9 queries, priced high to deter DOS" does not describe this path.
>
> **This changes the product narrative.** Our product sits entirely on the free path, so we cannot claim to generate ATC demand or burn. See [`05`](05-asc-integration-review.md) section 6.

### Full Hello Bridge run

| Step | Value |
|---|---|
| Sepolia mint | 50,969 gas |
| Sepolia burn | 30,721 gas, block 11,597,452 |
| Attestation wait | 8.5 minutes, 42 blocks |
| Proof generation, submission, mining | about 1 minute |
| **Burn to ASC application** | **9m 43s** |
| Result | 50 BTKT received |

### The constraint that did not go away

Funding stopped being a limit. Physics did not.

- Source chain finality plus attestation measures around 8.2 minutes.
- A failed end-to-end attempt costs eight minutes, so the number of attempts per day is still bounded.

**The "local mock harness first" rule stays.** Only its justification changed: not to conserve a query budget, but to conserve eight-minute cycles. Verify the whole ASC path on anvil against a mock BlockProver, and submit a real proof only when there is nothing left to learn locally. Without that, one typo costs eight minutes.

### An SDK weakness that shaped the worker

The first submission attempt waited eight minutes and then died at the last moment:

```
Waiting for block 11597452 attestation on Creditcoin...
Error: Failed to fetch attested height: AxiosError: timeout of 10000ms exceeded
  at ApiClient.<anonymous> (@gluwa/usc-sdk/dist/proof-provider/service/index.js:90:27)
```

`waitUntilHeightAttested()` retries on a 15-second loop, but the HTTP call inside it has a 10-second timeout and no retry of its own. The exception escapes the loop, and one API hiccup takes eight minutes with it.

> **Our worker does not use the SDK wait function.**
> - Polling calls get their own retry with exponential backoff.
> - Progress is persisted, so a dead process resumes rather than restarts.
> - Attestation belongs to the chain, not to our process. The source transaction stays valid, so retrying is always safe.

See [`06-worker-design.md`](06-worker-design.md).

## 6. Next steps

- [x] Receive funds from both faucets
- [x] `cast send ... "mint(uint256)" 50000000000000000000` on Sepolia
- [x] `cast send ... "burn(uint256)" 50000000000000000000`, capture the txHash
- [x] `yarn hello_bridge:submit_query <txHash>`, wait for attestation, generate the proof, submit to the ASC
- [x] `yarn utils:check_balance $ASC_MINTABLE_TOKEN <address>`, confirm 50.0 BTKT
- [x] Tutorial 4, Loan Flow, analysed in [`02-loan-flow-analysis.md`](02-loan-flow-analysis.md)

---

## Appendix: re-running the checks

`reference/attestcoin-protocol-examples/env_check.ts` re-verifies the environment at any time.

```sh
cd reference/attestcoin-protocol-examples && npx tsx env_check.ts
```

It prints connectivity for both chains, the supported chain list, and the latest attested height per chainKey with its lag against Sepolia head.
