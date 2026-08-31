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
| 3 | Guided issuance, `/verify` | 28 | `$DEMO_URL/verify` — steps 0 Wallet control, 1 ID document, 2 Bank account, 3 Screen and issue, run to ISSUED. Hold on the result panel: `demo:id` / `demo:bank` vendor rows, `KR_FSC_NONFACE_SANDBOX · level 3`, KR VASP production PASS, the Sepolia tx row. Copy that hash | `$DEMO_URL/verify`, block `SCENES=3` |
| 4 | The Sepolia issuance | 20 | `sepolia.etherscan.io/tx/<hash from scene 3>` — status Success, the `MarkIssued` log, `ComplianceSource` as the recipient. Then the contract page at `0x93C62D3016123Da0aBdB4AC1857564c30CbE5629` | `sepolia.etherscan.io`, block `SCENES=4` |
| 5 | Attestation, as a labelled edit | 16 | Split second: worker log tailing on the left, a full-frame caption on the right reading **"edited — attestation measured at 6.5–8.5 minutes"**. Cut from take A to take B under that caption; the caption stays up through the whole cut | worker log, caption in the editor |
| 6 | Creditcoin verdicts | 36 | Terminal, large font. One address holding two different contracts (18121 bytes on Creditcoin, 7479 on Sepolia); `expectedChainKey` 1; then the same mark twice — `isVerified(0xb8FEBEaB…, 1)` false, `isVerified(0xb8FEBEaB…, 2)` true; policy 1 re-read from chain, unchanged; then take B's subject under policy 1, true | block `SCENES=6`, `RECORD=1` for take B |
| 7 | GatedRwaNote refuses, then allows | 28 | Terminal. `canTransfer` false to the control wallet, true to the verified one; the call reverting with `0x17887111` `RecipientNotVerified`; then the live transfer landing status 1. Cut to the token on `creditcoin-testnet.blockscout.com` | block `SCENES=7`, `RECORD=1` |
| 8 | Revocation, and zero personal data | 18 | Terminal: `tombstone(0xFD1222…)` true, `isVerified` false under both policies. Then the full `getMark` dump — two 32-byte commitments and an issuer address, no name, no date of birth, no account number. Close on `$DEMO_URL/onchain` | block `SCENES=8`, `$DEMO_URL/onchain` |
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
- **Scene 8.** `0xFD1222e35a536A62f180aA44826656940e86bD5E` is the deployer, the issuer EOA and the
  revoked subject, all one testnet key. Narrate it as address reuse. Never as a compromised or
  tombstoned issuer key — `isVerified` reads the subject's tombstone only, and who may issue is
  decided by `ComplianceSource`'s allow-list on the source chain.

## If a live transaction fails on camera

Scenes 4 and 7 send real transactions, and a testnet can refuse at the wrong moment. Every one of
them has already happened once, and those receipts are on chain — cut to an explorer rather than
retrying on camera. All three were re-read and still return the status below.

| What | Chain | Transaction | Status |
|---|---|---|---|
| `issueBatch`, the two scene 7 marks in one transaction | Sepolia | `0x02cdf784fb7808b3d44b37a6e43b9145d7666519aca51d5497d4264bf3857c55` | 1, success |
| The gate refusing an unverified recipient | CC3 | `0x121b0d4f4213ba533e0284ec5e78db9d0d8054a970dee8947ab027f39528f18e` | 0, reverted |
| The same transfer to a verified recipient | CC3 | `0x6ec9dbedd37daa607a0df4e50026e61a049c620ce81981afa5f4ebdb39e431ce` | 1, success |

Narrate a cut like that as what it is — a transaction from an earlier run, not the one just sent.
README section 4 records all six transactions from that run and the propagation measured on it.

## Cast

| Address | Role in the video |
|---|---|
| `0xb8FEBEaB3705793474fA05b91Bf5D205855dD3c1` | The honest-pipeline mark. Fails policy 1, passes policy 2 — scene 6 |
| `$TAKE_B_SUBJECT` | Take B's subject, pre-issued through `/verify`. Passes policy 1 after the cut — scene 6 |
| `0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2` | Holder A. Holds 60 KRCN, passes policy 1, signs scene 7's transfers |
| `0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee` | Recipient B. Passes policy 1. The transfer the gate allows |
| `0x680Cc6e52d80F8f3759C7d7209f576CedCE7F2C5` | Control C. Never issued to. The transfer the gate refuses |
| `0xFD1222e35a536A62f180aA44826656940e86bD5E` | Revoked subject, and the same key as deployer and issuer — scene 8 |

## Frame notes

- 1920×1080, 30fps. Terminal at a font size that survives a laptop screen: aim for 24 lines visible,
  not 50.
- Browser in a clean profile — no bookmarks bar, no extensions, no other tabs.
- The `/verify` flow shows a resident registration number field. Use the PREFLIGHT test values and
  keep the field out of frame while typing if the screen recorder captures keystrokes.
- Cut the dead RPC latency between `cast` calls; it is not an edit that changes a claim, and it buys
  the seconds scene 6 needs.
