# Demo video — preflight

Run this top to bottom in the recording shell, minutes before the camera rolls. Every item is a
command with the answer it must give. **If an item fails, do not record**: the video would show a
broken deployment or claim something the chain no longer says.

Set the shell up once:

```sh
cd /Users/mac-inch/Stabled/attest-kyc
export DEMO_URL=https://attest-kyc.stabled.ai
export CC3=https://rpc.cc3-testnet.creditcoin.network
export SEP=https://ethereum-sepolia-rpc.publicnode.com
```

`cast`, `curl` and Node are required. A `missing field mixHash` warning from `cast` on CC3 is
harmless; Creditcoin runs a Substrate block format.

---

### a · The hosted demo answers

```sh
bash scripts/check-demo-urls.sh "$DEMO_URL"
```

→ 6 PASS lines, exit 0.

### b · Demo tier on, sandbox regime on, issuer key present

```sh
curl -s --max-time 30 "$DEMO_URL/api/kyc/status" | tr ',' '\n' | grep -E '"demo"|"sandboxBits"|"configured"|"vendor"'
```

→ `"demo":true`, `"sandboxBits":true`, `"configured":true` three times, vendors `demo:id` and
`demo:bank`. If `demo` is false the `/verify` flow returns 503 at step 1 and scene 3 cannot be filmed.

### c · Screening still blocks the preset

```sh
SCENES=2 bash docs/demo-video/commands.sh
```

→ `"decision":"BLOCK"`, `"riskBand":5`, `"entryId":"20157"`.

### d · Run the worker and the issuance scripts from a checkout that matches the live contracts

The working tree's `worker/` and `script/` target the roster-v2 contracts, which are **not
deployed**. Against the live ASC the worker refuses to start (`unsupported ASC transaction
processing version`). Use a worktree at the `v1-live` tag, the commit the live contracts were
built and verified from:

```sh
git worktree add ../attest-kyc-live v1-live
cd ../attest-kyc-live && npm ci && cp ../attest-kyc/.env .env
npm run verify:submission          # -> exit 0: this checkout matches the live deployment
npm run worker                     # leave running in its own terminal for the whole session
```

Or use the EC2 worker (`deploy/worker`, AWS profile `stabled-prod`): confirm it is running and
its cursor is moving before relying on it. Two workers on one deployment is fine; the ASC
consumes each query once.

Then confirm the cursor advances:

```sh
grep -o '"cursor": *[0-9]*' ../attest-kyc-live/state/worker-v2.json; sleep 30; grep -o '"cursor": *[0-9]*' ../attest-kyc-live/state/worker-v2.json
```

→ two readings, the second strictly larger. A cursor that does not move means nothing crosses today.
On 2026-09-07 the local cursor sat at Sepolia block 11,613,610 against a head of 11,651,492: the
local worker had been off for days. Start it early.

### e · The issuer account is funded on Sepolia

The account that signs `ComplianceSource` calls for the hosted deployment is the testnet deployer
`0xFD1222e35a536A62f180aA44826656940e86bD5E`. This role reuse is demo-only.

```sh
cast balance 0xFD1222e35a536A62f180aA44826656940e86bD5E --rpc-url "$SEP" --ether
cast call 0xA9A34586303b9fD92e090F9bb1D332DC854c72B9 'isIssuer(address)(bool)' 0xFD1222e35a536A62f180aA44826656940e86bD5E --rpc-url "$SEP"
```

→ comfortably above zero (0.047 ETH on 2026-09-07; an issuance is about 28k gas, the revocation
less) and `true`.

### f · Holder A is funded on Creditcoin

Scenes 6 sends one real transaction from holder A. Its testnet-only key is `DEMO_SUBJECT_A_KEY` in
the gitignored root `.env`.

```sh
cast balance 0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2 --rpc-url "$CC3" --ether
```

→ above zero (0.199 tCTC on 2026-09-07). Top up from the deployer, which holds about 9,999 tCTC.

### g · Both RPCs are healthy

```sh
cast chain-id --rpc-url "$CC3"   # -> 102031
cast chain-id --rpc-url "$SEP"   # -> 11155111
```

### h · Fresh marks for A and B, crossed, within policy 2's seven-day age

Policy 2 accepts a mark for **seven days** after issuance. Holder A's current mark was issued
2026-09-01 15:25:45 UTC and stops passing at **2026-09-08 15:25:45 UTC**. Re-issue before recording,
and again within seven days of judging so "run it yourself" still returns `true`:

```sh
cd ../attest-kyc-live
npx tsx script/demo-gate-issue.ts --dry-run   # both personas regime 2, bits 0x10024 present
npx tsx script/demo-gate-issue.ts             # one issueBatch on Sepolia; note the hash
```

Wait for the worker, then:

```sh
SCENES=5 bash docs/demo-video/commands.sh     # holder: false under 1, true under 2; no FAIL line
```

The gate run took about nine minutes last time. Fifteen minutes of head start is the recording
allowance, not a latency claim. Until scene 5 passes, do not record scenes 4 to 7.

If a previous take already revoked A (scene 7), this same re-issue reactivates it: a newer full
issuance clears an ordinary revocation tombstone.

### i · Scene 7 dress rehearsal, optional but recommended

The revocation wait is the one scene you cannot retake without a re-issue. If time allows, rehearse
once on recipient B the day before: `RWA_HOLDER=<B> RECORD=1 SCENES=7` with `DEMO_SUBJECT_B_KEY`,
then re-issue B in step h. That yields a measured wait for this week and a captioned fallback clip.

### j · The read-only sequence still matches the narration

```sh
bash docs/demo-video/commands.sh
```

→ every scene prints the values in its `# ->` comments and no `FAIL` line. This sends nothing and
reads no private key; it is safe as the last thing before recording.

### k · Recording hygiene

- [ ] Clean browser profile: no bookmarks bar, no extensions, no other tabs, no autofill dropdowns.
- [ ] Terminal font large enough to read at 1080p, prompt shortened, about 24 visible lines.
- [ ] Notifications off. No password managers, no chat popups, no calendar alerts.
- [ ] `.env` never on screen. Export `DEMO_SUBJECT_A_KEY` and `DEPLOYER_PRIVATE_KEY` in a terminal
      that is not being captured.
- [ ] Screen recorder keystroke overlay off. Use the synthetic sample preset in `/verify`.
- [ ] Scene 4 caption rendered: **edited — cross-chain propagation took about 9 minutes**.
- [ ] Scene 7 caption left blank until the take prints its elapsed time.
- [ ] Scene 6 is filmed before scene 7. After scene 7, A is revoked until step h runs again.
- [ ] Final cut is at most 2:00. Watch once with audio and once muted; hashes must stay readable.
