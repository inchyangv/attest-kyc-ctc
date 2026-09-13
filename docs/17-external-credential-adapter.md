# External credential adapter boundary and local conformance

> Version: `proofmark-adapter-v1` · status: provider-neutral specification plus a locally verified
> ES256K compact-JWS profile. No selected provider, regulated institution, approved credential,
> reuse/publication right, public-chain run or external consumer is claimed by this document.

## Purpose

An adapter translates one provider's authenticated credential into Proofmark's narrow vocabulary:
which checks ran, under which regime and jurisdiction, at what assurance, for which wallet, until
when, and from which issuer. It must not turn missing provider data into a positive method bit.

## Input envelope

```ts
interface ExternalCredentialEnvelopeV1 {
  schema: 'proofmark-adapter-v1';
  provider: string;                 // configured adapter ID, not display text
  credentialId: string;             // stable provider reference; never cleartext PII
  issuerId: string;                 // key/DID/account the adapter authenticates
  subject: {
    wallet: `0x${string}`;
    binding: 'provider-signed' | 'wallet-challenge';
  };
  issuedAt: string;                 // ISO-8601
  expiresAt: string;                // ISO-8601
  revokedAt?: string;               // present credentials are not issuable as Active
  assurance: number;                // provider grade, mapped by configuration
  jurisdiction: string;             // ISO-3166 alpha-2 at the boundary
  regime: string;                   // provider-native regime ID
  checks: string[];                 // provider-native performed checks
  evidenceDigest: `0x${string}`;    // commitment or authenticated provider reference
  proof: unknown;                   // provider signature, VC/JWT, API receipt or ZK proof
}
```

The production implementation should accept the provider's native credential, not trust a caller
to populate this envelope. The adapter constructs the envelope only after authenticating the
provider proof.

## Implemented local profile

[`pipeline/external-credential.ts`](../pipeline/external-credential.ts) implements a strict
`proofmark-external-jwt-v1` compact-JWS boundary. It accepts only an `ES256K`/`JWT` header with the
configured key ID, verifies the raw 64-byte JWS signature against a pinned issuer address, and
requires exact `iss`, `aud`, wallet `sub`, bytes32 `jti`, `iat`, `exp`, provider, product and
environment fields. The payload has an exact allowlist of keys; an identity field cannot be added
to the accepted profile. A caller also supplies the expected wallet, so a genuine credential for a
different subject is rejected rather than normalized.

Assurance, regime, ISO-3166 numeric jurisdiction and method bits come only from immutable adapter
configuration. Unknown checks earn no bit, every configured required check must be present, and
the resulting expiry is the earlier of provider expiry and the configured freshness ceiling. A
sandbox credential cannot enter a production adapter. `jti` is HMAC-pseudonymized before it enters
normalized output, and the source request ID is derived from that digest and the pinned source
issuer. The compact credential itself is not returned. `claimsRoot` is zero because this adapter
does not manufacture selectively disclosable Proofmark claims from a provider assertion.

Provider publication and adapter publication are separate explicit modes. Provider publication
requires the JWS signer and Source issuer to be the same address. Adapter publication permits a
different pinned Source issuer, making the extra Proofmark trust boundary visible to consumer
policy. Neither setting grants the corresponding Source role or permission to reuse/publish a
credential.

The status client and atomic replay store are injected dependencies. `unknown`, malformed and
transport-error status cannot issue; `revoked` or `expired` produces a revocation instruction, not
an Active credential. The included in-memory replay store is a local conformance fixture only.
Production admission still requires a provider-native status transport and a durable multi-host
claim store or the existing journal/Source `issueOnce` boundary.

## Output

```ts
interface NormalizedCredentialV1 {
  schema: 'proofmark-normalized-v1';
  subject: `0x${string}`;
  issuer: `0x${string}`;            // address pinned by the consuming policy
  methods: number;                  // Proofmark Methods bitmap
  assurance: number;
  regime: number;
  jurisdiction: number;             // ISO-3166 numeric
  issuedAt: number;
  expiry: number;
  providerCredentialIdHash: `0x${string}`;
  evidenceHash: `0x${string}`;
}
```

No cleartext identity field belongs in the normalized output or source event.

## Mandatory adapter operations

```ts
interface CredentialAdapterV1 {
  readonly id: string;
  authenticate(rawCredential: unknown, context: { wallet: `0x${string}` }): Promise<ExternalCredentialEnvelopeV1>;
  normalize(envelope: ExternalCredentialEnvelopeV1): Promise<NormalizedCredentialV1>;
  status(credentialId: string): Promise<'active' | 'revoked' | 'expired' | 'unknown'>;
}
```

`authenticate` verifies issuer authenticity. `normalize` is a configured, reviewable mapping rather
than provider-supplied arbitrary numbers. `status` feeds rescreen and revocation; issuance alone is
not enough for a reusable compliance credential.

## Mapping rules

- Every Proofmark method bit maps to explicit provider evidence that the check ran.
- A provider result labelled test, demo or sandbox can map only to a sandbox Proofmark regime.
- Assurance mapping is provider- and product-specific; a raw provider number is not copied blindly.
  Repository-native issuance separately applies the [T-31 identity/assurance boundary](86-identity-assurance-boundary.md):
  an adapter number alone does not establish actual-person, representative or UBO verification.
- Jurisdiction comes from the verification regime, not an IP address or wallet location.
- Expiry is the minimum of provider expiry and the configured Proofmark freshness ceiling.
- Unknown issuer, unknown check, unknown regime or unsupported jurisdiction fails closed.
- A revoked or expired credential never emits an Active issuance.
- Provider credential IDs are keyed/hashed before entering evidence; no document or account number
  enters the source event.

## Source publication models

| Model | Proven source statement | Additional trust |
|---|---|---|
| Provider publishes | The independent provider emitted the normalized credential event | Provider must support or authorise source-event publication |
| Proofmark adapter publishes | Proofmark emitted after authenticating the provider credential | Consumers trust the Proofmark issuer plus the retained provider proof |

The first is the strongest Attestcoin provenance. The second is acceptable only when the policy
names the Proofmark adapter issuer and the evidence/SLA contract makes the trust boundary explicit.
Provider permission for credential reuse and event publication is a commercial admission gate, not
a code assumption.

## Conformance suite

An adapter is accepted only when all cases pass:

| Case | Expected result | Current local evidence |
|---|---|---|
| Valid provider signature and supported product | Normalized credential produced | ES256K fixture passes |
| Invalid or unknown issuer key/key ID | Reject | unit conformance passes |
| Wrong audience or wallet subject | Reject | `PM-T30-01` and subject cases pass |
| Duplicate credential or replayed provider event | Same request ID, no second issuance | 20 concurrent claims have one fresh result; Source `issueOnce` rejects replay |
| Sandbox credential labelled as production | Reject | unit conformance passes |
| Unknown provider check | Ignore that check; never assign a bit | unit conformance passes |
| Missing required evidence for a mapped check | Leave bit unset or reject according to mapping | configured-required case rejects |
| Assurance outside configured mapping | Reject | unit conformance passes |
| Unsupported regime or jurisdiction | Reject | unit and consumer-policy cases pass |
| Expired/future credential | Reject | unit conformance passes |
| Revoked/expired provider status | Emit/queue revocation; do not issue Active | local instruction and Source→ASC revoke pass |
| Revocation arrives before delayed issuance | Source ordering keeps the revoked state | protocol lifecycle tests cover ordering; provider-native timing is not tested |
| Provider API timeout or unknown status | Fail closed and retry without issuing | injected error/unknown cases pass; no real provider API evidence |
| Evidence contains cleartext PII | Reject in the PII guard | exact JWT schema rejects additional identity fields |
| Wrong issuer, regime or jurisdiction at registry | Consumer policy returns false | independent local consumer process rejects all three |

`npx tsx --test pipeline/external-credential.test.ts` passes **7/7** local conformance cases. It was
first run before the module existed and failed **0/1** at module load. `npm run
test:external-credential` passes **1/1** connected integration: a synthetic external key signs the
compact credential, sends the resulting idempotent issuance to an isolated Sepolia-chain-ID
Anvil, the actual receipt is relayed to an isolated Creditcoin-chain-ID Anvil with the repository's
mock native verifier, and `examples/consumer/check.ts` runs as a separate process. Its exact Direct
policy accepts, issuer/regime/jurisdiction variants reject, and an actual source revocation changes
the accepted policy to rejected. The baseline after this addition is Solidity **118/118** and root
TypeScript **555/555**, with typecheck passing.

All keys, subjects, credentials, status answers, chains and evidence in those tests are synthetic.
The native Attestcoin proof is mocked, Direct policy does not provide continuing roster freshness,
and a repository child process is not a team-external consumer.

## Partner admission questions

1. May the credential be reused by more than one Creditcoin application?
2. May its result or a normalized event be published on Ethereum?
3. What key or DID authenticates the issuer, and how is rotation announced?
4. How are revocation and correction delivered, ordered and retried?
5. What exact checks, countries, assurance and sandbox semantics are contractually supported?
6. What evidence may be retained, by whom, in which region and for how long?
7. What SLA and liability apply to false allow, false deny and late revocation?

The local profile is a reusable admission boundary, not the first external milestone. That
milestone still requires a customer-needed provider selection; contract/terms evidence for cost,
rate limit, credential reuse, chain publication, retention, liability and support; the provider's
native credential and authenticated status/revocation transport; approved secrets and durable
replay state; a credential created in the authorized environment; public testnet Source/native
proof execution; and a team-external consumer accepting and rejecting the approved policy.
