Proofmark issues KYC/AML marks on Ethereum Sepolia and makes Creditcoin CC3 the chain of record for them. Remove Attestcoin and what is left is a relayer we operate, which is exactly the trust the product exists to remove. The protocol is what makes an off-chain claim checkable on another chain without trusting us.

Integration points:

1. ProofmarkASC on CC3 (`0x3C6Fe016645CA52952E29C66E435bDa7F611b242`) verifies Sepolia inclusion and continuity proofs through the BlockProver precompile and materialises marks into state in one Creditcoin block.
2. The worker polls attested height, fetches the proof and submits it to `execute()`. The 2026-09-02 deployment carried a two-subject issuance in about nine minutes; the exact source and CC3 transaction hashes are recorded in the root README and deployment artifacts.
3. Deploy-time preflight reads chainKey from the ChainInfo precompile rather than hardcoding it: Sepolia is chainKey 1, not chainId 11155111.
4. ComplianceSource.issueBatch and revokeBatch put N events in one source transaction, so one execute() applies all N.

Integrating also surfaced three security gaps in ASCBase, fixed in our fork ASCBaseX: `execute()` did not forward `chainKey`, `blockHeight`, or transaction index to the handler, so a handler could neither pin the source chain nor impose a total order on events for one subject. The guards are mutation tested, including two opposing events in the same source block. The findings and regression tests are documented in `docs/09-ascbase-security-findings.md`.
