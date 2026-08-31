# Runbook: CODEF demo tier, so the ID axis runs real Government24 checks

> 2026-09-01 · Tech Lead
> Background: [`../07-kyc-vendors.md`](../07-kyc-vendors.md) sections 3 and 5.
> Code: `pipeline/adapters/codef.ts`, `web/lib/kyc-server.ts`, `web/app/api/kyc/{id,status}/route.ts`, `web/app/verify/page.tsx`.
> Preflight: [`../../script/check_codef.ts`](../../script/check_codef.ts).
> Nothing in this file is a credential. Every value in angle brackets is a placeholder.

---

## 1. What this unlocks, and what it does not

With CODEF demo-tier credentials the **ID axis** of `/verify` stops being a stand-in and asks the issuing authority:

| Document | Authority | Endpoint |
|---|---|---|
| Resident registration card | Government24 | `POST /v1/kr/public/mw/identity-card/check-status` |
| Driver licence | Traffic Civil Service 24 (Korean National Police Agency) | `POST /v1/kr/public/ef/driver-license/status` |

Each check is approved on the operator's phone through app-based authentication (KakaoTalk by default).

The **bank axis does not change**. It stays on the labelled demo vendor (`demo:bank`) that `KYC_DEMO=1` supplies, because the one-won rail needs either the KFTC participating-institution registration or the CODEF partnership contract ([`../07-kyc-vendors.md`](../07-kyc-vendors.md) section 4.3). A real ID axis next to a demo bank axis is **by design**, not a broken state: the mix is per axis, and every surface says which is which.

While **any** axis is not live:

- the mark carries `regime = KR_FSC_NONFACE_SANDBOX` (2), not the production regime — do not describe the mixed setup as production;
- the evidence carries the vendor name and the `live` flag **per axis** (`codef:demo` with `live: true` for the document, `demo:bank` with `live: false` for the account);
- `/verify` keeps its demo band, which then names the bank axis alone: *"Demo mode. No real vendor behind: bank account."*

---

## 2. Sign-up (human)

1. Register at **codef.io**.
2. Apply for the **demo service**. Approval is granted by the vendor and can take time — start this first, everything else is minutes of work.
3. Open **My Page → Key Management** and copy three values: `clientId`, `clientSecret`, `publicKey`.

The demo tier queries the **real** Government24 and Traffic Civil Service 24 within a daily allowance. `sandbox` is a different thing entirely (fixed sample data, section 8); `api` is production and needs the partnership contract.

---

## 3. Variable mapping

From the CODEF console:

| Key Management value | Variable |
|---|---|
| `clientId` | `CODEF_CLIENT_ID` |
| `clientSecret` | `CODEF_CLIENT_SECRET` |
| `publicKey` (the base64 body shown in Key Management) | `CODEF_PUBLIC_KEY` |

Fixed for this path:

| Variable | Value | Why |
|---|---|---|
| `CODEF_ENV` | `demo` | `CODEF_ENV=demo` is `https://development.codef.io`: the real institutions, daily allowance |
| `CODEF_LOGIN_TYPE` | `simple` | `CODEF_LOGIN_TYPE=simple` is app-based authentication, so no joint-certificate file is needed |
| `CODEF_SIMPLE_LEVEL` | `1` | `CODEF_SIMPLE_LEVEL=1` is KakaoTalk. Also: `3` Samsung Pass · `4` KB Mobile · `5` carrier PASS (which additionally needs `CODEF_LOGIN_TELECOM`: `0` SKT, `1` KT, `2` LG U+) · `6` Naver · `7` Shinhan · `8` Toss · `9` Hana · `10` NH |

The operator identity:

| Variable | Value |
|---|---|
| `CODEF_LOGIN_USER_NAME` | the operator's name exactly as the authentication app knows it, e.g. `<operator-name>` |
| `CODEF_LOGIN_PHONE` | the operator's phone number, digits only, e.g. `<operator-phone-digits-only>` |
| `CODEF_LOGIN_IDENTITY` | the operator's 13-digit resident registration number, e.g. `<operator-13-digit-resident-number>` |

**This identity is the operator's, never the customer's.** The authorities require the *requesting party* to log in and then answer about a document that belongs to someone else; the CODEF guide calls it third-party authentication. `CODEF_LOGIN_*` therefore describes the person at Proofmark who approves each lookup, while the customer's name, birth date and document number arrive per request from the `/verify` form. The operator's phone must have the chosen authentication app installed and enrolled, because every single check waits on a tap in that app.

Two more variables belong to the deployment, not to CODEF: `KYC_DEMO=1` and `KYC_DEMO_BITS=1` (section 5).

---

## 4. Local preflight

Put the values in `web/.env.local` (gitignored; `web/.env.example` lists every key with its comment), then:

```bash
npx tsx script/check_codef.ts web/.env.local
```

`script/check_codef.ts` reads the same variables `web/lib/kyc-server.ts` reads and applies the same defaults (`CODEF_ENV` → `demo`, `CODEF_LOGIN_TYPE` → cert, `CODEF_SIMPLE_LEVEL` → `1`), then validates the credentials for real: it builds a `CodefClient`, encrypts a probe string with `CODEF_PUBLIC_KEY` (RSA/PKCS#1 v1.5, the padding the resident-number tail is sent with), and exchanges the client credentials for an access token at `https://oauth.codef.io/oauth/token`. It reports pass or fail **without ever printing a secret** — only `CODEF_ENV`, `CODEF_LOGIN_TYPE` and `CODEF_SIMPLE_LEVEL` appear in its output, and any other `CODEF_*` value is redacted on the way out even if a library error quotes it back. It writes no file.

Every line must read `PASS` before you touch Vercel:

```
CODEF preflight · env demo · login simple · level 1
PASS env-file
PASS client-vars
PASS env
PASS login
PASS public-key
PASS token
```

Exit code 0 means no check failed (`WARN` lines are allowed and explain themselves); exit 1 means at least one `FAIL`. Section 8 maps each `FAIL` to its cause.

---

## 5. Vercel production (human)

The production deployment is the Vercel project **`stabled-ai/proofmark`**. The CLI's default scope is a different team, so **every** command needs `--scope stabled-ai` — without it the CLI resolves the project under the default scope, which is a different team. Run the commands from the directory that carries the link (`.vercel/project.json`; the repo root has it today, and `web/` works too if you link it there). If the CLI reports no link: `npx vercel link --project proofmark --scope stabled-ai`.

Add the nine variables one at a time. `vercel env add` prompts for the value, so no credential ever reaches shell history or a file:

```bash
for NAME in CODEF_CLIENT_ID CODEF_CLIENT_SECRET CODEF_PUBLIC_KEY \
            CODEF_ENV CODEF_LOGIN_TYPE CODEF_SIMPLE_LEVEL \
            CODEF_LOGIN_USER_NAME CODEF_LOGIN_PHONE CODEF_LOGIN_IDENTITY; do
  npx vercel env add "$NAME" production --scope stabled-ai
done
```

(`CODEF_ENV` = `demo`, `CODEF_LOGIN_TYPE` = `simple`, `CODEF_SIMPLE_LEVEL` = `1`; the other six come from sections 2 and 3.)

Confirm the demo switches are present in production too:

```bash
npx vercel env ls production --scope stabled-ai | grep -E 'KYC_DEMO|CODEF_'
```

`KYC_DEMO=1` and `KYC_DEMO_BITS=1` must both be set. They are what gives the bank axis its self-disclosing demo vendor instead of a 503; add them the same way if they are missing. Then redeploy — environment variables only reach the running app through a new build:

```bash
npx vercel deploy --prod --scope stabled-ai
```

Variables added to `production` do not apply to preview deployments; add them to `preview` as well if you want a real ID axis on a branch URL.

---

## 6. Post-deploy verification

The stable production URL is **https://attest-kyc.stabled.ai** (second project domain, same build: https://proofmark-swart.vercel.app). `bash scripts/check-demo-urls.sh` checks both. The URL of the deployment that is currently promoted can be listed with `npx vercel ls --scope stabled-ai`.

```bash
curl -s https://attest-kyc.stabled.ai/api/kyc/status | jq .id
```

Expected:

```json
{
  "configured": true,
  "vendor": "codef:demo:simple",
  "live": true,
  "demo": false,
  "env": "demo",
  "missing": []
}
```

`codef:demo:simple` is `codef:<env>:<loginKind>`, assembled in `web/lib/kyc-server.ts` — the `:simple` suffix is the proof that the app-based login, not the certificate login, is the one configured. `live: true` is what sets the document bit on issuance; `demo: false` means the demo stand-in is gone from this axis.

The bank axis is expected to stay demo, and the top-level flags stay on:

```bash
curl -s https://attest-kyc.stabled.ai/api/kyc/status \
  | jq -c '{demo,sandboxBits,id:{v:.id.vendor,l:.id.live,d:.id.demo},bank:{v:.bank.vendor,l:.bank.live,d:.bank.demo}}'
# {"demo":true,"sandboxBits":true,"id":{"v":"codef:demo:simple","l":true,"d":false},"bank":{"v":"demo:bank","l":false,"d":true}}
```

If `id.vendor` is still `demo:id`, the CODEF variables did not reach the running build: check `id.missing` in the response — it names exactly which variables the server could not read.

---

## 7. Running a real check

On `/verify`, step 1 now talks to the authority:

1. The customer's document details are submitted (OCR prefill, then the customer confirms the fields).
2. CODEF answers `CF-03002` with `continue2Way: true` and `method: simpleAuth` — **every** check comes back this way once. The page shows *"The authority asks for approval in the certificate app."* and an **"I approved it"** button.
   (While the second leg is pending, the step-1 status pill reads *Captcha* — one label covers both second legs, `secureNo` and `simpleAuth`. The panel text below it is the accurate one.)
3. The operator approves the request in KakaoTalk on the phone registered as `CODEF_LOGIN_PHONE`.
4. Click **"I approved it"**. The browser returns the sealed two-way token, the server repeats the request body with `is2Way: true`, `twoWayInfo` and `simpleAuth: "1"`, and Government24 or Traffic Civil Service 24 answers.
5. Step 1 ends **Authentic**, with `vendor: "codef:demo"` and `live: true` in the returned summary. (The per-request vendor name has no login suffix; only `/api/kyc/status` appends `:simple`.)

**Approve promptly.** The authority holds the session about three minutes, and the sealed two-way token minted by `web/app/api/kyc/id/route.ts` expires after 170 s. Past that, the step has to be started again.

---

## 8. Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Checks start failing after repeated lookups on the same day | The demo tier's daily allowance is exhausted (CODEF sets the number, and it is not published in the guide) | Wait for the next day, or move to `api` once the partnership contract exists |
| `idTwoWay token expired; start the step again` | The 170 s two-way window closed before the approval | Restart step 1 and approve in the app promptly |
| Nothing arrives in KakaoTalk | Wrong `CODEF_LOGIN_PHONE`, a name that does not match the app enrolment, or the app not enrolled on that phone | Fix the operator identity (section 3) and rerun the preflight |
| `CODEF_ENV` is `sandbox` | The sandbox host answers from fixed sample data and never reaches an authority | Use `demo`. With `KYC_DEMO_BITS=1` the bit is still set on the mark, but the evidence records `live: false` and the mark stays `regime = KR_FSC_NONFACE_SANDBOX`; with `KYC_DEMO_BITS=0` the bit stays unset. Never use `sandbox` for a check you intend to show |
| A driver licence returns `resAuthenticity "2"` | The licence number exists, but the anti-forgery serial number did not check out | Treated as a rejection — the customer should re-enter the serial from the card; issuance stops until it verifies |
| `FAIL token: CODEF token request failed: HTTP 401` | `CODEF_CLIENT_ID` / `CODEF_CLIENT_SECRET` do not match, or belong to a different CODEF account | Re-copy both from Key Management |
| `FAIL public-key: … DECODER routines::unsupported` | `CODEF_PUBLIC_KEY` is not the base64 body from Key Management (truncated, wrapped, or a different field) | Re-copy `publicKey`; the script accepts it with or without the PEM header |
| `FAIL login: app-based login is missing: …` | The named operator variables are unset in the environment being checked | Set them in `web/.env.local` locally, or in the `production` environment on Vercel |
| `WARN login: CODEF_LOGIN_TYPE is not set` | The app then falls back to the certificate login, which needs `CODEF_CERT_*` files | Set `CODEF_LOGIN_TYPE=simple` explicitly |
| `/api/kyc/status` shows `id.demo: true` after a deploy | The variables were added to the wrong environment, or no redeploy happened | Check `id.missing`, add what it names, then `npx vercel deploy --prod --scope stabled-ai` |
| Either axis answers 503 with a list of variables | No vendor and no demo mode | That is the designed behaviour: there is no silent mock. Set the vendor variables, or `KYC_DEMO=1` |
