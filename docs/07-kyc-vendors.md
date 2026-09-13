# KYC vendors: what is real, what is demo, and how to connect each

> **2026-09-10 addition:** native hosted Sumsub onboarding is implemented separately at `/verify/provider`; see [setup and limits](89-sumsub-onboarding.md). Its authenticated overall review is a non-issuable evidence candidate, not a replacement for actual per-check evidence. The Korean flow below remains available at `/verify`; a real vendor session and its onchain issuance bridge are different acceptance gates.

> 2026-08-31 · Tech Lead
> Background: [`03-product-plan.md`](03-product-plan.md) section 4.2 (the Korean adapter) and section 16 D4.
> Code: `pipeline/adapters/{kr,codef,openbanking,demo}.ts`, `web/lib/kyc-server.ts`, `web/app/api/kyc/*`, `web/app/verify/page.tsx`.
> Verified: 123 TypeScript tests, `next build`, and the full `/verify` flow driven through the API in demo mode (section 8).

---

## 1. The decision

Current working-tree caveat (2026-09-07): [institution HTTP limits](40-vendor-http-boundaries.md) remove automatic POST replay, and [public diagnostic projection](41-public-diagnostic-boundary.md) omits upstream error messages/references, uses fixed two-way instructions and applies no-store responses. This does not change retained evidence hashes or establish live institutional approval. Earlier verification counts and the demo journey below are historical, not proof that the current hardened deployment has been released.

The two regulatory checks in the Korean adapter, **document authenticity with the issuing authority** (FSC method 1) and **an existing bank account through a one-won transfer** (method 4), are integrated against real vendors in code. The commercial side of some of them cannot be arranged before the deadline, so the rule is:

> Onboard what onboards today. Where an institution cannot be reached yet, a **demo vendor** stands in, and every surface says so: the page, the evidence, and the mark's `regime`.

There is no silent mock. An axis is either a real vendor, the labelled demo vendor under `KYC_DEMO=1`, or unconfigured, in which case the API answers 503 with the names of the missing variables.

---

## 2. What onboards today

| Axis | Self-service today | Path | Result on the mark |
|---|---|---|---|
| **ID document**: resident registration card (Government24), driver licence (Korean National Police Agency Traffic Civil Service 24), plus OCR | **Yes.** CODEF demo tier with app-based authentication | Section 3 | `live`, bit set, regime production |
| **Bank account**: holder name + one won | Testbed only: KFTC Open Banking | Section 4 | not live: the real API, canned answers, no money moves |
| Bank account, real rails | Not yet: one of two commercial rails, the KFTC registration or the CODEF contract, planned step by step in section 4.3 | Section 4.3 | `live`, bit set |

Real and demo mix per axis. With CODEF configured and nothing for the bank, the document is checked for real and the account is demo.

---

## 3. ID document: CODEF

### 3.1 Sign-up

1. Register at codef.io and apply for the **demo service**.
2. Go to My Page → **Key Management** and copy `clientId`, `clientSecret`, and `publicKey`.
3. Set `CODEF_ENV=demo`. The demo tier queries the real Government24 and Traffic Civil Service 24 within a daily allowance. `sandbox` answers from fixed sample data and is never live; `api` is production.

The operational path — every variable, the Vercel production commands, the post-deploy check and the failure modes — is [`runbooks/codef-demo-onboarding.md`](runbooks/codef-demo-onboarding.md), and `npx tsx script/check_codef.ts web/.env.local` validates the three keys against the CODEF token endpoint before a deploy without printing any of them.

### 3.2 Login: app-based authentication, no certificate file

The authorities require the *requesting party* to log in; the document being checked belongs to the customer (the guide calls this "third-party authentication"). Two ways are implemented:

| `CODEF_LOGIN_TYPE` | What it needs | Behaviour |
|---|---|---|
| `simple` | The operator's name, phone, 13-digit resident number, and an app: `CODEF_SIMPLE_LEVEL` 1 KakaoTalk · 3 Samsung Pass · 4 KB Mobile · 5 carrier PASS (`CODEF_LOGIN_TELECOM` 0 SKT · 1 KT · 2 LG U+) · 6 Naver · 7 Shinhan · 8 Toss · 9 Hana · 10 NH | Every check comes back once as `CF-03002 / simpleAuth`; the operator approves on the phone; the page sends the second leg and the authority answers. This is the quickest route to a live lookup: nothing but a demo key and a phone |
| `cert` | The issuer's joint certificate as files: `CODEF_CERT_TYPE=pfx` + `CODEF_CERT_FILE` (base64), or `1` + `CODEF_CERT_FILE` (der) + `CODEF_KEY_FILE`; `CODEF_CERT_PASSWORD` (plain, RSA-encrypted per request with the account `publicKey`); `CODEF_LOGIN_USER_NAME` (corporate or personal name) and `CODEF_LOGIN_IDENTITY` (business registration number or resident registration number) | One shot. A corporate certificate on Traffic Civil Service 24 gets a captcha leg (`secureNo`), which the page shows as an image and answers |

### 3.3 Products and wire format

| Product | Endpoint | Notes |
|---|---|---|
| Resident registration authenticity (KR_PB_MW_035) | `POST /v1/kr/public/mw/identity-card/check-status` | `organization 0002`; `identityEncYn Y`, `birthDate yymmdd`, `identity` = RSA of the last seven digits; `issueDate YYYYMMDD`. `resAuthenticity "1"` is genuine |
| Driver-licence authenticity (KR_PB_EF_001) | `POST /v1/kr/public/ef/driver-license/status` | `organization 0001`; licence number split `licenseNo01..04` (2-2-6-2); `serialNo` (anti-forgery serial number) is required. `"1"` genuine; `"2"` = number exists, serial did not verify, treated as a rejection |
| Resident registration card / driver-licence OCR (KR_ETC_KYC_001/002) | `POST /v1/kr/etc/a/kyc/registration-card`, `/drivers-license` | multipart `file`, ≤ 5 MB. Fields prefill the form; the customer confirms them against the card |

Protocol, from the REST guide: token `POST https://oauth.codef.io/oauth/token` with Basic `clientId:clientSecret` and `grant_type=client_credentials&scope=read`, valid a week and cached; requests are URL-encoded JSON with a Bearer header; responses are URL-encoded JSON `{ result: { code, message, transactionId }, data }`; `CF-00000` is success; `CF-03002` with `data.continue2Way = true` asks for a second leg, sent to the same endpoint with the first body plus `is2Way: true`, `twoWayInfo: { jobIndex, threadIndex, jti, twoWayTimestamp }` and the answer (`secureNo` or `simpleAuth: "1"`). The authority holds the session about three minutes.

The developer site is a SPA; the parameter tables came from `https://admin.codef.io/dev-guide-menu/{menu-detail,api-input-param,api-output-param}/{menuCode}?mode=real`.

### 3.4 What is not integrated

Face match and liveness. CODEF has no face product; those bits stay unset until a face vendor is added.

---

## 4. Bank account

### 4.1 KFTC Open Banking (`BANK_VENDOR=openbanking`, default)

1. Register at developers.kftc.or.kr (an individual developer must complete identity verification) and create a test app: `client_id`, `client_secret`, and the ten-character institution use code.
2. Set `OPENBANKING_CLIENT_ID`, `OPENBANKING_CLIENT_SECRET`, `OPENBANKING_CLIENT_USE_CODE`, the institution's contracted account `OPENBANKING_CNTR_ACCOUNT_NUM` (type `N`, or `C` for a fintech use number), `OPENBANKING_WD_PASS_PHRASE` (the withdrawal-transfer passphrase registered with KFTC), and `OPENBANKING_ENV=test`.

| Step | Endpoint | Notes |
|---|---|---|
| Token | `POST /oauth/2.0/token` | 2-legged: `client_id`, `client_secret`, `scope=oob`, `grant_type=client_credentials` |
| Holder name | `POST /v2.0/inquiry/real_name` | `bank_code_std` (3 digits), `account_num`, `account_holder_info_type " "`, `account_holder_info` = first six digits of the resident number; `rsp_code A0000` |
| One won | `POST /v2.0/transfer/deposit/acnt_num` | `tran_amt "1"`, `print_content "PM" + 4 digits` as the sender, `name_check_option on`; success is `A0000` **and** `res_list[0].bank_rsp_code "000"` |

`bank_tran_id` is the institution use code + `U` + nine characters, unique per call; `tran_dtime` is KST. Hosts: `testapi.openbanking.or.kr` (test), `openapi.openbanking.or.kr` (prod).

The testbed runs the real API against canned data and moves nothing, so the vendor reports `live = false`. The flow completes (under demo the code is shown, since no statement exists), the bit is not set unless demo bits are on.

### 4.2 CODEF bank products (`BANK_VENDOR=codef`)

Account-holder authentication (`/v1/kr/bank/a/account/holder-authentication`: `organization` = `0` + bank code, `account`, `identity` = YYMMDD) and account authentication by one-won transfer (`/v1/kr/bank/a/account/transfer-authentication`, `inPrintType 0` = four random digits as the depositor, returns `authCode`). These are partnership products: the demo server returns random test data, so the class refuses to construct on anything but `CODEF_ENV=api`.

### 4.3 Production rails: the milestone plan

Signing either rail — KFTC participating-institution registration or the CODEF partnership contract — turns the bank axis live. Combined with the document axis, a mark issued through `/verify` then carries `ID_DOC_AUTHENTICITY` (0x4), `BANK_ACCOUNT` (0x20) and `SANCTIONS_SCREENED` (0x10000) from live rails and can pass frozen policy #1 on `ProofmarkRegistry` (CC3 testnet, `0x2F4E5e1270f90E51251651caf08547393e3C0572`) when it also matches production regime 1, KR jurisdiction 410, the pinned issuer and the 30-day age limit. Nothing in the policy is relaxed for the demo.

**Rail A — KFTC Open Banking production**

| Step | Owner (role) | Estimated duration (estimate, not a commitment) | Status | Unblocks |
|---|---|---|---|---|
| a. Adapter and wire-format tests: the 2-legged token, the `real_name` inquiry, the one-won deposit judged on `bank_rsp_code` — `pipeline/adapters/openbanking.ts`, `pipeline/openbanking.test.ts` | engineering | — (already in the repo) | Done | Nothing further on the code side; steps b to e are registration work |
| b. Developer-site registration and a test app at developers.kftc.or.kr (the individual developer completes identity verification) | engineering | days (assumption) | Not started | Testbed credentials for step c |
| c. Testbed validation with `OPENBANKING_ENV=test`. Testbed answers are canned, no money moves, the vendor records `live = false`, and the bank bit stays unset | engineering | days (assumption) | Not started | Wire-format proof against the real API ahead of review |
| d. Participating-institution registration application and KFTC review | compliance lead, with BD | weeks (KFTC review) | Not started | Permission to call the production host |
| e. Production credentials configured: `OPENBANKING_CLIENT_ID`, `OPENBANKING_CLIENT_SECRET`, `OPENBANKING_CLIENT_USE_CODE`, `OPENBANKING_CNTR_ACCOUNT_NUM`, `OPENBANKING_WD_PASS_PHRASE`, `OPENBANKING_ENV=prod` | engineering | hours (assumption) | Not started | `BANK_ACCOUNT` (0x20) off a live rail: `live = true`, bit set |

**Rail B — CODEF partnership contract (bank products)**

| Step | Owner (role) | Estimated duration (estimate, not a commitment) | Status | Unblocks |
|---|---|---|---|---|
| a. Adapter for the two bank products, holder authentication and one-won transfer authentication — `pipeline/adapters/codef.ts`, `pipeline/codef.test.ts`. The safeguard is already in place: the bank-product class refuses to construct on anything but `CODEF_ENV=api`, because the demo and sandbox servers answer these two products with random test data | engineering | — (already in the repo) | Done | Nothing further on the code side; steps b to d are commercial work |
| b. CODEF demo-tier account at codef.io (self-service; the same account also unlocks the live document axis through app-based authentication, section 3) | engineering | days (assumption) | Not started | The document axis, live. Not the bank axis: the bank products need `api` |
| c. Partnership contract negotiation with CODEF | BD, with compliance lead | weeks (vendor-side review and contracting) | Not started | Access to the bank products on the production host |
| d. Production keys with `CODEF_ENV=api` and `BANK_VENDOR=codef` | engineering | hours (assumption) | Not started | `BANK_ACCOUNT` (0x20) off a live rail: `live = true`, bit set |

Status reflects what this repository can prove as of the last edit; it is updated as applications are filed.

Either bank rail live, together with the document axis live on CODEF, is the whole unblock: a mark issued through `/verify` carries `methods` including `0x10024`, policy #1 passes on chain, and the mark's `regime` is production `KR_FSC_NONFACE` instead of `KR_FSC_NONFACE_SANDBOX`.

---

## 5. Demo mode

`KYC_DEMO=1` (`web/lib/kyc-server.ts`). Any axis with no real vendor gets `pipeline/adapters/demo.ts`.

| Property | Demo vendor |
|---|---|
| Interface and inputs | Identical to CODEF and Open Banking. Tokens, reconciliation, screening, commitment and evidence run unchanged |
| Institutions asked | None. `live = false`, vendor `demo:id` / `demo:bank`, references `demo-…` |
| OCR | Reads nothing; the customer types and the page says so |
| Rejection paths, for a demo | A name containing `FAKE` (or the Korean equivalent), or a document number of one repeated digit → not authentic → issuance stops. An account ending in `99` belongs to `Different Person` → holder mismatch |
| One-won code | Derived from the account (stable on retry) and **shown on the page** in place of the bank app. A live rail never reveals it |
| Bits | `KYC_DEMO_BITS=1` (default): the adapter's `sandboxBits` switch counts non-live results, so the mark ends with `0x190027` and assurance 3. `KYC_DEMO_BITS=0` leaves the two bits unset |
| Regime | Always `KR_FSC_NONFACE_SANDBOX` (2) when either axis is not live. The evidence carries `sandboxBits`, `live` and the vendor name per axis |

The page shows a "Demo mode" band naming the demo axes, and the result distinguishes the frozen production policy from the frozen sandbox pilot policy.

**The boundary is enforced on chain.** Deployed policy #1 requires `0x10024`, assurance 2, regime 1, jurisdiction 410, a trusted issuer, and a 30-day maximum age. Policy #2 requires the same methods and issuer but pins sandbox regime 2 and a seven-day age. Both are frozen. A demo mark can pass policy #2 and cannot pass policy #1.

---

## 6. Environment reference

All keys with comments: `web/.env.example`. Grouped:

| Group | Keys |
|---|---|
| Demo | `KYC_DEMO`, `KYC_DEMO_BITS` |
| CODEF client | `CODEF_CLIENT_ID`, `CODEF_CLIENT_SECRET`, `CODEF_PUBLIC_KEY`, `CODEF_ENV` (`sandbox` / `demo` / `api`) |
| CODEF login, simple | `CODEF_LOGIN_TYPE=simple`, `CODEF_SIMPLE_LEVEL`, `CODEF_LOGIN_PHONE`, `CODEF_LOGIN_TELECOM`, `CODEF_LOGIN_USER_NAME`, `CODEF_LOGIN_IDENTITY` (13 digits) |
| CODEF login, cert | `CODEF_LOGIN_TYPE=cert`, `CODEF_CERT_TYPE`, `CODEF_CERT_FILE`, `CODEF_KEY_FILE`, `CODEF_CERT_PASSWORD`, `CODEF_LOGIN_USER_NAME`, `CODEF_LOGIN_IDENTITY` |
| Bank | `BANK_VENDOR` (`openbanking` / `codef`), `OPENBANKING_CLIENT_ID`, `OPENBANKING_CLIENT_SECRET`, `OPENBANKING_CLIENT_USE_CODE`, `OPENBANKING_CNTR_ACCOUNT_TYPE`, `OPENBANKING_CNTR_ACCOUNT_NUM`, `OPENBANKING_WD_PASS_PHRASE`, `OPENBANKING_PRINT_NAME`, `OPENBANKING_ENV` |
| Issuer | `ISSUER_PRIVATE_KEY` (allow-listed with `setIssuer`), `NEXT_PUBLIC_SEPOLIA_RPC`, `NEXT_PUBLIC_SOURCE` |
| Sealing | Dedicated `SERVER_TOKEN_KEY` + `SERVER_TOKEN_KEY_ID`; optional bounded previous key triplet during rotation |

Local: `web/.env.local` may carry `KYC_DEMO=1`; `/verify` needs the dedicated token/evidence and issuance state settings even when no vendor is configured. Deployment, minimum token settings for the demo include:

```
vercel env add KYC_DEMO production            # 1
vercel env add SERVER_TOKEN_KEY production    # independent high-entropy secret
vercel env add SERVER_TOKEN_KEY_ID production # opaque current version, for example token-k1
vercel env add ISSUER_PRIVATE_KEY production  # without it the pipeline runs and the Sepolia tx is skipped
```

then the CODEF keys as they arrive; the document axis turns real on redeploy, the bank axis stays demo.

---

## 7. The flow, and where the personal data is

| Step | Route | What crosses the browser |
|---|---|---|
| 0 wallet | `GET/POST /api/kyc/wallet` | EIP-4361 message with a sealed nonce; signature checked with viem; returns `walletProof` |
| 1 document | `POST /api/kyc/id` (multipart) | `action=ocr` prefill; `action=verify` returns `idProof` (sealed result: name, DOB, `docHash`, authenticity, vendor, `live`) or a two-way challenge with `twoWayToken` (170 s). The image is hashed (`keccak256`) and discarded; the resident number is used for the query and never stored |
| 2 bank | `POST /api/kyc/bank` | `start`: holder name compared with the declared name, one won sent, sealed `challenge` carrying an HMAC of the code (never the code); `verify`: five tries, then `bankProof` |
| 3 issue | `POST /api/kyc/issue` | Opens proofs bound to the same wallet/flow, runs reconciliation, AML, claims and `packAttrs`, stores a production evidence record, then calls replay-safe `ComplianceSource.issueOnce(requestId,...)`. The public demo retains no server-side record and says so |

Sealed tokens are AES-256-GCM under a dedicated, key-ID-bound `SERVER_TOKEN_KEY` with a type tag and expiry; a forged, retired-key or expired token is a 400. A bounded rotation may accept one explicitly configured previous key until its Unix-millisecond deadline while every new token uses the current key. Evidence never holds a name, number or account: vendor, reference, `live`, decision codes and hashes only (`pipeline/pii-guard.ts` checks this in tests).

---

## 8. Verified

- `npm run test:ts`: 123 tests. Coverage includes vendor wire formats, adapter honesty, replay/order handling, adversarial roster proofs, encrypted-vault authentication, review/rescreen lifecycle and erasure.
- `tsc` at root and in `web/`; `next build --webpack`; `config.resolve.modules` points root-level `pipeline/` at `web/node_modules`, and `ethers` is a `web/` dependency, so the Vercel build resolves.
- Against the built server with `KYC_DEMO=1`: status reports demo on both axes → consent-bound wallet round trip → demo OCR → document verified / `FAKE` rejected → account ending `99` mismatch → one won with the code revealed → wrong code counted → right code → issue: `ISSUED`, methods `0x190027`, regime 2, assurance 3, policy #2 passes and policy #1 fails; evidence names `demo:id` and `demo:bank`, with no cleartext PII. With no issuer key the transaction is skipped and says so.
- Without `KYC_DEMO`: each vendor step is a 503 listing the missing variables; a forged signature is 422, a forged proof 400, Kim Jong Un · KP → `DENIED`.

---

## 9. Left

| Item | Why it matters |
|---|---|
| Face match and liveness vendor | `FACE_MATCH`, `LIVENESS` stay unset |
| Bank rails | KFTC participating-institution registration or the CODEF partnership contract |
| Managed evidence service | The AES-GCM file vault is a single-instance pilot; production needs database/KMS, backup, rotation, access control and audit logging |
| Distributed API controls | Current application throttles are per instance; production needs gateway/WAF rate limiting |
| Corporate certificate on Traffic Civil Service 24 | Manual captcha every time; app-based authentication avoids it |
