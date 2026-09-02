# Demo video — shot list

Three minutes is the ceiling the competition sets, and the proof arc is what it is scoring: a fact
issued on Ethereum, attested through Attestcoin, and driving an on-chain decision on Creditcoin.
Scenes 4, 5 and 6 are that arc and take 72 of the 178 seconds budgeted below.

Recording runs against the hosted deployment `https://attest-kyc.stabled.ai` and the two testnets.
Run [PREFLIGHT.md](PREFLIGHT.md) first; read [NARRATION.md](NARRATION.md) over the top; the terminal
scenes come from [commands.sh](commands.sh), one scene at a time:

```sh
SCENES=6 bash docs/demo-video/commands.sh
```

Two takes carry the whole video. **Take A** is filmed live: the screening, the `/verify` issuance,
the Sepolia transaction. **Take B** is a second mark pushed through `/verify` about fifteen minutes
before recording starts (PREFLIGHT step i), so that when scene 5 cuts, scene 6 has a mark whose
attestation has genuinely crossed. The cut is labelled on screen. The wait is never presented as
real time and never as immediate.

## Scenes

| # | Scene | Seconds | On screen | Source |
|---|---|---|---|---|
| 1 | Cold open | 12 | Title card over the landing page. "Proofmark — a KYC mark issued on Ethereum, verified on Creditcoin, gating a tokenised note." Contract addresses held for two seconds | `$DEMO_URL/` |
| 2 | Live sanctions screening | 20 | `$DEMO_URL/` — click the "Kim Jong Un · KP" preset, run it. BLOCK, risk band 5, the OFAC SDN hit `entryId 20157` with `corroborated: dob`. Scroll once to "Checks performed" so the unset PEP and adverse-media bits are visible | `$DEMO_URL/`, block `SCENES=2` |
| 3 | Guided issuance, `/verify` | 28 | `$DEMO_URL/verify` — steps 0 Wallet control, 1 ID document, 2 Bank account, 3 Screen and issue. Hold on `demo:id` / `demo:bank`, sandbox regime, production FAIL, pilot PASS, and the Sepolia transaction | `$DEMO_URL/verify`, block `SCENES=3` |
| 4 | The Sepolia issuance | 20 | `sepolia.etherscan.io/tx/<hash from scene 3>` — status Success, `MarkIssued`, and `ComplianceSource`. Then current source `0xA9A34586303b9fD92e090F9bb1D332DC854c72B9` | `sepolia.etherscan.io`, block `SCENES=4` |
| 5 | Attestation, as a labelled edit | 16 | Worker log plus the full-frame caption **"edited — cross-chain propagation took about 9 minutes"**. Cut from take A to take B under that caption | worker log, caption in the editor |
| 6 | Creditcoin verdicts | 36 | Both contracts have runtime code; `expectedChainKey` is 1 and source address is pinned; the same mark fails policy 1 and passes policy 2; both policies frozen; take B passes policy 2 | block `SCENES=6`, `RECORD=1` for take B |
| 7 | GatedRwaNote refuses, then allows | 28 | Terminal. `canTransfer` false to the control wallet, true to the verified one; the call reverting with `0x17887111` `RecipientNotVerified`; then the live transfer landing status 1. Cut to the token on `creditcoin-testnet.blockscout.com` | block `SCENES=7`, `RECORD=1` |
| 8 | Fail closed, no cleartext personal data | 18 | An unissued control fails both policies. Then the active `getMark` dump — commitments and scoped metadata, no cleartext name, birth date, document or account number | block `SCENES=8`, `$DEMO_URL/onchain` |
| | **Total** | **178** | under the 180-second ceiling, 2 seconds of headroom | |

## What each scene must not do

- **Scene 3.** The vendor rows saying `demo:id` and `demo:bank` have to be legible, and the
  narration has to say it out loud. The mark discloses the same thing on chain in its regime field.
  The screening axis in the same flow is real, against the loaded lists — say which is which.
- **Scene 5.** No speed ramp without the caption, and no wording that implies the attestation was
  quick. The caption text above is the wording that ships.
- **Scene 6.** `tombstone` and `getMark` are functions of `ProofmarkASC`; `isVerified` is on
  `ProofmarkRegistry`. Calling one on the other's address is the mistake that looks like a bug on
  camera.
- **Scene 7.** Keep `--from` on the read-only revert. Without it `msg.sender` is zero, `onlyOwner`
  fires before the gate, and the frame shows `0x118cdaa7 OwnableUnauthorizedAccount` — the wrong
  error entirely. Two error selectors that both look like "reverted".
- **Scene 8.** Do not say anonymous or zero data. Wallets, issuer, method metadata and commitments
  are public and linkable; the narrower claim is no cleartext personal fields on chain.

## If a live transaction fails on camera

Scenes 4 and 7 send real transactions, and a testnet can refuse at the wrong moment. Every one of
them has already happened once, and those receipts are on chain — cut to an explorer rather than
retrying on camera. All three were re-read and still return the status below.

| What | Chain | Transaction | Status |
|---|---|---|---|
| `issueBatch`, the two current marks | Sepolia | `0x290498028010e6ce5f75de3d69695091e24863423e01a7981a277db86c8d69f1` | 1, success |
| Mint 100 KPCN to verified A | CC3 | `0xa1f3b9fa62419b0352376d633b703442830d95a45179772825e44397342f8e77` | 1, success |
| Transfer 40 KPCN from verified A to verified B | CC3 | `0xefe550ff98e513b8c6cd7fa8541fd1d7d0f33197b149fb674df8acba7aa9aa0d` | 1, success |

Narrate a cut like that as what it is — a transaction from an earlier run, not the one just sent.
README section 4 records all six transactions from that run and the propagation measured on it.

## Cast

| Address | Role in the video |
|---|---|
| `0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2` | Holder A. Holds 60 KPCN; fails production policy 1 and passes sandbox policy 2 |
| `0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee` | Recipient B. Holds 40 KPCN and passes policy 2 |
| `$TAKE_B_SUBJECT` | Optional take B, pre-issued through `/verify`; passes policy 2 after the cut |
| `0x00000000000000000000000000000000DeaDBeef` | Unissued control; the gate refuses it and both policies fail |

## Frame notes

- 1920×1080, 30fps. Terminal at a font size that survives a laptop screen: aim for 24 lines visible,
  not 50.
- Browser in a clean profile — no bookmarks bar, no extensions, no other tabs.
- The `/verify` flow shows a resident registration number field. Use the PREFLIGHT test values and
  keep the field out of frame while typing if the screen recorder captures keystrokes.
- Cut the dead RPC latency between `cast` calls; it is not an edit that changes a claim, and it buys
  the seconds scene 6 needs.
