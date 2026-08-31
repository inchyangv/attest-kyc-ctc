Proofmark issues KYC/AML marks on Ethereum Sepolia and makes Creditcoin CC3 the chain of record for them. Remove Attestcoin and what is left is a relayer we operate, which is exactly the trust the product exists to remove. The protocol is what makes an off-chain claim checkable on another chain without trusting us.

Integration points:

1. ProofmarkASC on CC3 (0x93C62D3016123Da0aBdB4AC1857564c30CbE5629) verifies Sepolia inclusion and continuity proofs through the BlockProver precompile and materialises marks into state in one Creditcoin block.
2. The worker polls attested height, fetches the proof and submits it to execute(). Measured issuance to isVerified true: 7m 55s and 10m 48s over two runs.
3. Deploy-time preflight reads chainKey from the ChainInfo precompile rather than hardcoding it: Sepolia is chainKey 1, not chainId 11155111.
4. ComplianceSource.issueBatch and revokeBatch put N events in one source transaction, so one execute() applies all N.

Integrating also surfaced two security gaps in ASCBase, fixed in our fork ASCBaseX: execute() forwards neither chainKey nor blockHeight to the handler, so a handler cannot pin the source chain (CC3 serves chainKey 1 and 3 at once) nor reject a stale proof that resurrects a revoked mark. Both guards are mutation tested: remove either and exactly its test fails, test_RejectsProofFromWrongChain or test_StaleIssueCannotResurrectRevokedMark. Written up in docs/09-ascbase-security-findings.md and offered to the Attestcoin team.
