# Sumsub onboarding — integration boundary

WIN-01, 2026-09-10. This integration starts a genuine hosted verification flow and retrieves an authenticated provider review result. It does **not** mint a Proofmark credential or grant asset access. Overall provider GREEN is not evidence of every individual check: the first evidence candidate deliberately has `methods = 0` and no asserted jurisdiction until native step evidence is mapped and tested (WIN-02).

## Operator setup

Use the variable names in [web/.env.example](../web/.env.example). Do not commit values or send keys in chat. Configure the app in one environment and provide only its corresponding API token/secret, webhook secret and verification level. `SUMSUB_ENVIRONMENT=sandbox` is an actual provider sandbox, not Proofmark's synthetic `KYC_DEMO=1` mode; hosted onboarding refuses the latter.

For a local technical check, put `SUMSUB_SANDBOX_APP_TOKEN` and `SUMSUB_SANDBOX_SECRET_KEY` in the repository `.env`, then run `npm run sumsub:setup`. The command validates the credentials against Sumsub, selects the account's `id-and-liveness` level, generates distinct local custody keys, and updates the ignored `.env` and `web/.env.local` files with mode `0600`. It enables `SUMSUB_SANDBOX_TEST_MODE=1`, which uses synthetic policies, blocks issuance, and tells the user to use only Sumsub's official test documents. Local memory state is accepted only when `SUMSUB_LOCAL_TEST=1`; a Vercel runtime always requires Redis.

Run the local app with `npm --prefix web run dev` and open `/verify/provider`. The provider-specific wallet challenge is served at `/api/providers/sumsub/wallet`, so its token cannot be reused by the issuance routes.

For a deployed Sandbox check, connect an Upstash Redis resource and map its REST URL and token to `SUMSUB_STATE_REDIS_REST_URL` and `SUMSUB_STATE_REDIS_REST_TOKEN`. Do not deploy `SUMSUB_STATE_MODE=memory` or `SUMSUB_LOCAL_TEST`. In Sumsub Dashboard, add an HTTPS webhook targeting `/api/providers/sumsub/webhook`, paste the same `SUMSUB_SANDBOX_WEBHOOK_SECRET`, choose SHA-256, and enable the applicant created, pending, on-hold, and reviewed events. A signed Dashboard test delivery returns success without reading or changing applicant state. Production credentials still require actual approved identity, processing, and retention policy manifests; Sandbox test mode is rejected with production credentials.

To keep the fixed fictional lesson on `/demo` available in this non-demo provider deployment, explicitly set `SANCTIONS_TRAINING_ENABLED=1`. This flag affects only the fixed-scenario education endpoint, which rejects personal fields and cannot issue credentials. It does not switch the issuance pipeline into demo mode.

Separate the API secret, webhook secret, evidence HMAC key, state encryption key and browser token key. Use a durable Redis REST service for sessions, callback replay state and observations; do not use memory state in a deployed route. Configure `SUMSUB_STATE_TTL_SECONDS` against the approved retention/monitoring plan rather than copying an arbitrary retention period. The hosted API domain initially supported is `https://api.sumsub.com`; local data processing regions need an explicit policy and origin review.

Before enabling real document/face capture:

- Obtain actual provider access and a level suitable for the desired checks. Sandbox results cannot become production credentials.
- Configure approved `IDENTITY_POLICY_JSON`, `PROCESSING_POLICY_JSON`, `RETENTION_POLICY_JSON`, and server-token custody. Approval references must correspond to real decisions, not sample strings.
- The identity policy must authorize face match/liveness for this hosted flow. The processing policy must cover the exact `SUMSUB_PROCESSING_RECIPIENT`, the `id_document` stage and document images, identity fields, biometric templates, screening results and credential metadata. It must also describe actual recipients/locations/purposes. Refer to [identity assurance](86-identity-assurance-boundary.md) and [processing policy](87-processing-policy-boundary.md).
- Configure the webhook URL `/api/providers/sumsub/webhook` with HMAC SHA-256. Verify a signed callback and its environment/subject/current-state binding in a private sandbox before using actual personal data.
- Rehearse provider downtime, duplicate/out-of-order callback, retry after failed re-fetch, changed wallet, and approval followed by ongoing review/rejection. A callback can restrict progress; it cannot mint.

## Browser and API contract

The `/verify/provider` document alone permits Sumsub script/frame origins and camera/microphone delegation. Links into this route use a full document navigation, because client-side routing would retain the previous document's CSP. Geolocation/payment/USB remain disabled. The SDK is not loaded on ordinary home/demo pages. The user reviews the exact server-generated consent message before signing, and the hosted SDK starts only after the bound token request succeeds.

| Endpoint | Trust boundary |
|---|---|
| `GET /api/providers/sumsub/status` | Local configuration/policy readiness only; no vendor call, session or verification result |
| `POST /api/providers/sumsub/token` | Existing wallet proof + current processing/retention/identity policy; server-created external ID; short-lived SDK token |
| `POST /api/providers/sumsub/status` | Wallet proof + sealed provider proof; caller cannot choose applicant ID; current upstream re-query |
| `POST /api/providers/sumsub/webhook` | Exact raw-byte digest, algorithm, timestamp, environment and known subject; anti-replay + current upstream re-query |

No API accepts a browser `approved: true`, arbitrary method bitmap, nationality or applicant ID as authority to issue. Client SDK events are progress hints only. Applicant identifiers are pseudonymized, not anonymous; the provider still handles personal data and the wallet-linked flow is sensitive.

REST observations label their environment evidence as `configured-credentials`; a matched signed callback records `signed-webhook`. Separate environment variables cannot independently prove an operator selected the correct provider account. This distinction must be resolved before the issuance bridge grants an environment-specific credential. Webhook delivery also has a configured age ceiling; missed or delayed negative events require reconciliation, not an assumption of continuing approval.

State updates use pre-fetch revision CAS. A stale status request returns no new approval if another update committed first. Webhook candidate, ordering watermark, applicant binding and replay marker commit in one Redis Lua operation; a lost HTTP response can be retried without losing the restriction. The configured Redis TTL is still an operational retention setting, not a monitoring SLA or automatic legal approval.

## Remaining integration gates

WIN-02 maps authenticated step outcomes to credential checks and jurisdiction semantics, and connects AML/vault/issuance journal/source outbox. WIN-03 connects ongoing provider events to the existing rescreen/revocation lifecycle. WIN-07 connects authenticated active roots to the new minimal-disclosure proof path. None is implied by a successful hosted session or green local HTTP test.

Source: [official WebSDK integration](https://docs.sumsub.com/docs/get-started-with-web-sdk), [verification webhooks](https://docs.sumsub.com/docs/user-verification-webhooks). This runbook is an engineering setup guide, not a conclusion that a provider level satisfies a particular jurisdiction's legal obligations.
