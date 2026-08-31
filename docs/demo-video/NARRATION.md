# Demo video — narration

English, read as voiceover, keyed to the scene numbers in [SHOTLIST.md](SHOTLIST.md). Each scene's
lines are budgeted at about two and a half words per second of its allotted time — roughly 150 words
per minute, which is a calm reading pace, not a rushed one.

Every spoken number comes from a measurement in this repository, with the provenance said out loud:
"measured", "across two runs", "over 200 listed people". Nothing is rounded up, nothing is
extrapolated, and the attestation wait is never described as quick.

The narration body is every blockquoted line below. To check the budget:

```sh
grep '^> ' docs/demo-video/NARRATION.md | sed 's/^> //' | wc -w      # 448 words, budget 450
```

---

## 1 · Cold open — 12s, ~30 words

> Tokenised assets have to know who holds them. Proofmark issues a KYC mark on Ethereum, verifies it
> trustlessly on Creditcoin through Attestcoin, and lets a credit note refuse anyone who fails.

*On screen: the landing page, then the contract addresses.*

## 2 · Live sanctions screening — 20s, ~50 words

> Screening first, and this part is real. Three sanctions lists, 26,566 entries, loaded from source.
> A listed name, corroborated by date of birth and country: block, risk band five. Measured recall
> was 100 percent over 200 listed people, 0 false positives over 610 ordinary names. Checks we have
> not licensed stay unset: silence, not a guess.

*On screen: the Kim Jong Un preset, the OFAC SDN hit, the unset PEP and adverse-media bits.*

## 3 · Guided issuance — 28s, ~70 words

> Now onboarding. Wallet control, an identity document, a bank account, then screening — and only
> the checks that actually ran set a bit. About this deployment: the identity and bank vendors here
> are labelled demo adapters. The mark says so on chain, in its regime field — Korean
> non-face sandbox. The sanctions screening in the same flow is real. Both axes passed, so assurance
> is level three, and the mark passes Korea's production policy.

*On screen: the `demo:id` and `demo:bank` vendor rows, `KR_FSC_NONFACE_SANDBOX · level 3`, PASS.*

## 4 · The Sepolia issuance — 20s, ~50 words

> The mark is now a transaction on Ethereum Sepolia. ComplianceSource dot issue, 27,933 gas
> measured. What goes on chain is a methods bitmap, an assurance level, a jurisdiction, and two
> 32-byte commitments. The evidence and the claims stay off chain. The commitments are all another
> chain needs.

*On screen: Etherscan, status Success, the `MarkIssued` log.*

## 5 · Attestation, as a labelled edit — 16s, ~40 words

> Attestation is where the wait lives. Source-chain confirmation was measured at 6.5 to 8.5 minutes,
> and issuance to a verified answer took 7 minutes 55 and 10 minutes 48 across two runs. This cut is
> edited, and labelled so.

*On screen: the caption "edited — attestation measured at 6.5–8.5 minutes", held through the cut.*

## 6 · Creditcoin verdicts — 36s, ~90 words

> On Creditcoin, one address holds two contracts: the verifier here, the issuer on
> Sepolia. Same deployer, same nonce, two chains. The verifier accepts proofs from one source chain
> and one source contract only.
>
> Then the point. One mark, two policies, two answers. Under Korea's production policy, false — it
> never carried a document authenticity bit. Under the pilot policy, true. Portability is a return
> value here, not a promise. Verifying the proof on Creditcoin cost 386,008 gas measured. And the
> mark the cut waited for now passes production.

*On screen: `isVerified(0xb8FEBEaB…, 1)` false, `(…, 2)` true, then take B's subject under policy 1.*

## 7 · The gate — 28s, ~70 words

> A tokenised credit note, gated on that same policy. Send to an unverified wallet: the token's own
> preflight says no, and the transfer reverts — recipient not verified. That is the gate, not an
> owner check. Send to a verified wallet and the same call succeeds. Remove Attestcoin and this
> stops working: no signing server sits behind the gate, only a mark that crossed a chain boundary.

*On screen: `canTransfer` false then true, `0x17887111`, then the live transfer at status 1.*

## 8 · Revocation, and zero personal data — 18s, ~45 words

> Last, revocation. This subject's mark was hand-authored during testing and claimed checks we never
> ran, so we revoked it. Propagation to Creditcoin was measured at 8 minutes 43. And the whole
> record: commitments and an issuer address. No name, no date of birth, no account number.

*On screen: `tombstone` true, `isVerified` false under both policies, the full `getMark` dump.*

---

## Things not to say

- **Never "a compromised key."** The revoked subject in scene 8 is the same testnet address as the
  deployer and the issuer EOA. That is one key reused for three roles on a testnet. Verification
  never consults the issuer's tombstone: `isVerified` reads the subject only, and who may issue is
  decided by `ComplianceSource`'s allow-list on the source chain.
- **Never a number that is not in this file.** The measured set is fixed: 27,933 gas issuance;
  6.5–8.5 minutes attestation; 7m 55s and 10m 48s issuance to verified across two runs; 8m 43s
  revocation propagation; 386,008 gas proof verification; 26,566 list entries, being OFAC SDN
  19,321, UN 1,011 and EU 6,234; recall 100% over n=200; 0 false positives over n=610; evasion 7 of
  7. If a scene needs a figure that is not on that list, cut the claim, not the provenance.
- **Never describe the demo vendors as anything but demo vendors.** They label themselves in the
  vendor name, the evidence references, the mark's regime field and the user interface, and scene 3
  says so on camera.
- **Never a second product name.** The product is Proofmark.
