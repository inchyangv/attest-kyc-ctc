# Demo video — preflight

Run this top to bottom in the recording shell, minutes before the camera rolls. Every item is a
command with the answer it must give. **If an item fails, do not record** — the video would either
show a broken deployment or claim something the chain no longer says.

Set the shell up once:

```sh
cd /Users/mac-inch/Stabled/attest-kyc
export DEMO_URL=https://attest-kyc.stabled.ai      # the hosted demo, the only URL named in the kit
export CC3=https://rpc.cc3-testnet.creditcoin.network
export SEP=https://ethereum-sepolia-rpc.publicnode.com
```

`cast` and `curl` are the only tools required. A `missing field mixHash` warning from `cast` on CC3
is harmless — Creditcoin runs a Substrate block format — and every command below still returns.

---

### a · The hosted demo answers

```sh
curl -s -o /dev/null -w '%{http_code}\n' --max-time 30 "$DEMO_URL/"
```

→ `200`. For all three pages and all three API routes at once:
`bash scripts/check-demo-urls.sh "$DEMO_URL"` → 6 PASS lines, exit 0.

### b · Demo tier on, sandbox regime on, issuer key present

```sh
curl -s --max-time 30 "$DEMO_URL/api/kyc/status" | tr ',' '\n' | grep -E '"demo"|"sandboxBits"|"configured"|"vendor"'
```

→ `"demo":true`, `"sandboxBits":true`, `"configured":true` three times (id, bank, issuer), and the
vendor names `demo:id` and `demo:bank`. If `demo` is false the `/verify` flow returns 503 at step 1
and scene 3 cannot be filmed.

Note: `issuer.address` in that JSON is `ComplianceSource` on Sepolia — the contract the issuer writes
to, not the signing account. The signing account comes back as `onchain.issuer` in the issuance
response, and is checked in step (e) below.

### c · Screening still blocks the preset

```sh
curl -s --max-time 30 -X POST "$DEMO_URL/api/screen" -H 'content-type: application/json' \
  -d '{"fullName":"Kim Jong Un","dateOfBirth":"1984-01-08","nationality":"KP"}' \
  | tr ',' '\n' | grep -E '"decision"|"riskBand"|"entryId"'
```

→ `"decision":"BLOCK"`, `"riskBand":5`, `"entryId":"20157"`.

### d · The relay worker is alive and moving

Sepolia events reach Creditcoin only while the worker runs. In a second terminal, from the repo root:

```sh
npm run worker
```

Then confirm the cursor advances:

```sh
grep -o '"cursor": *[0-9]*' state/worker.json; sleep 30; grep -o '"cursor": *[0-9]*' state/worker.json
```

→ two readings, the second strictly larger. A cursor that does not move means the take-A issuance in
scene 3 will never cross, and scene 6's take-B verdict is the only proof left on camera.

### e · The issuer account is funded on Sepolia

The account that signs `ComplianceSource.issue` for the hosted deployment is
`0xFD1222e35a536A62f180aA44826656940e86bD5E` — the same testnet key as the deployer, the note owner
and the revoked subject in scene 8 (README section 4 records that reuse).

```sh
cast balance 0xFD1222e35a536A62f180aA44826656940e86bD5E --rpc-url "$SEP"
cast call 0x93C62D3016123Da0aBdB4AC1857564c30CbE5629 'isIssuer(address)(bool)' \
  0xFD1222e35a536A62f180aA44826656940e86bD5E --rpc-url "$SEP"
```

→ a balance comfortably above zero (0.048 ETH on 2026-09-01, tens of issuances' worth at the
measured 27,933 gas) and `true` from the allow-list. If a `/verify` issuance ever returns without an
`onchain.txHash`, check this first.

### f · The scene 7 signer is funded on Creditcoin

Scene 7 sends two real transactions from holder A. Its testnet-only key is `DEMO_SUBJECT_A_KEY` in
the gitignored root `.env`.

```sh
cast balance 0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2 --rpc-url "$CC3"
```

→ above zero (0.199 tCTC on 2026-09-01, enough for both transactions). Top up from
`0xFD1222e35a536A62f180aA44826656940e86bD5E`, which holds about 9,999 tCTC, if it has run dry.

### g · Both RPCs are healthy

```sh
cast chain-id --rpc-url "$CC3"   # -> 102031
cast chain-id --rpc-url "$SEP"   # -> 11155111
```

### h · The scene 7 cast still passes and fails as scripted

```sh
REG=0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc
cast call $REG 'isVerified(address,uint256)(bool)' 0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2 1 --rpc-url "$CC3"  # A -> true
cast call $REG 'isVerified(address,uint256)(bool)' 0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee 1 --rpc-url "$CC3"  # B -> true
cast call $REG 'isVerified(address,uint256)(bool)' 0x680Cc6e52d80F8f3759C7d7209f576CedCE7F2C5 1 --rpc-url "$CC3"  # C -> false
```

→ `true`, `true`, `false`. A and B are `RWA_HOLDER` and `RWA_RECIPIENT`; C is the control the gate
refuses. If A or B has stopped passing, issue a fresh mark through `/verify` to a wallet you hold the
key for and export it as `RWA_RECIPIENT`.

### i · Pre-issue take B, about 15 minutes before recording

Scene 5 cuts from take A to take B, and take B only works if its attestation has already crossed.

1. Open `$DEMO_URL/verify` in a throwaway browser profile and run all four steps to `ISSUED`. Use a
   wallet address you do not mind publishing; the result panel shows the subject.
2. Note the subject address and the Sepolia tx hash.
3. Export both in the recording shell:

```sh
export TAKE_B_SUBJECT=0x…            # the subject from the result panel
export SEPOLIA_TX=0x…                # optional, lets scene 4's block print the explorer URL
```

4. Wait, then confirm it has crossed before you start recording:

```sh
cast call 0x874e0Fd030a8Fe6c7a06835354531b68A31f5FCc 'isVerified(address,uint256)(bool)' \
  "$TAKE_B_SUBJECT" 1 --rpc-url "$CC3"
```

→ `true`. Attestation was measured at 6.5 to 8.5 minutes and issuance to a verified answer at
7m 55s and 10m 48s across two runs; the gate run recorded in README section 4 took 9m 18s. Fifteen
minutes of head start covers all three. Until it returns `true`, keep waiting — do not record scene
6 and do not shorten the labelled caption.

### j · The read-only sequence still matches the kit

```sh
env -u RECORD bash docs/demo-video/commands.sh
```

→ exit 0, and every printed value matches its `# ->` comment. This sends nothing and needs no
exported variable, so it is safe to run as the last thing before recording.

### k · Recording hygiene

- [ ] Clean browser profile: no bookmarks bar, no extensions, no other tabs, no autofill dropdowns.
- [ ] Terminal font large enough to read at 1080p — about 24 visible lines, not 50. Prompt shortened
      to something that is not your home directory path.
- [ ] Notifications off. No password managers, no chat popups, no calendar alerts.
- [ ] `.env` never on screen. The two scene 7 transactions read `DEMO_SUBJECT_A_KEY` from the
      environment; export it before recording, in a terminal that is not being captured.
- [ ] Screen recorder keystroke overlay off — the `/verify` flow has a resident registration number
      field.
- [ ] The caption for scene 5 already rendered in the editor: **edited — attestation measured at
      6.5–8.5 minutes**.
- [ ] Final cut is at most 3:00. The shot list budgets 178 seconds; 2 seconds is the whole margin.
