# T-38 — Wallet changes and stale browser responses

2026-09-07. **IN_PROGRESS.** This implements a local browser session boundary, not a verified wallet/device support matrix, ERC-1271 support or public-chain E2E result.

## Confirmed problem and change

The verification page previously requested accounts and a signature once, then retained the resulting wallet proof, ID/bank proofs and issued result without subscribing to wallet changes. An in-flight response could still restore those details after a user changed accounts or disconnected. The API's same-wallet flow checks did not tell the browser that its selected wallet had changed.

The new browser-safe `pipeline/wallet-session.ts` tracks a session revision, selected account and exact provider object. A connection installs its own accountsChanged, chainChanged and disconnect listeners before account permission/signature work. Account comparison is case-insensitive; an unchanged first account does not clear the session. Empty/malformed or different accounts, a chain change or disconnect invalidate it. Late permission responses, callbacks from an older attachment and previous revision results are rejected.

The event interface and account/chain notification meanings follow the published [EIP-1193 specification](https://eips.ethereum.org/EIPS/eip-1193#events). The page now requires both event subscription and listener removal methods; a request-only injected object receives an explicit unsupported-wallet explanation before signing. This is an implementation boundary, not a claim that every provider exposing those methods behaves correctly.

Before and after each flow API call, the page checks the same provider and reads `eth_accounts` without requesting another signature. That detects a silently changed account or provider at the next interaction/response boundary. Permission/signature completion also checks the session before proceeding. Chain changes conservatively require reconnection; this does not add a chain ID to the existing signature payload, prove a network's identity or automatically switch the wallet's network.

Invalidation clears the local wallet/ID/bank tokens, challenge and two-way state, document image/entered fields, sample preview, consent and issued-result display. Busy/error completions from an older revision cannot overwrite the current flow. The notice explains the reason and that already-sent work may still complete. An invalidated fetch is not described as cancellation of a bank request or source transaction.

Saved per-wallet recovery IDs remain in session storage. They are hidden from the current cleared form until the original wallet reconnects, when the existing [recovery mechanism](22-issuance-recovery.md) can load them. No new wallet is silently adopted, authenticated or issued a credential. A caller knowing an ID still needs the server's same-wallet proof.

Only this session's listeners are removed on replacement, invalidation or unmount; other consumers' listeners are left alone. Revision checks still reject stale callbacks if a provider's removal method fails. Clearing state means removing usable/displayed data from this flow, not forensic erasure of browser memory, old pending closures, server records or public chain data.

## Verification

Four root tests cover account/chain/disconnect invalidation, unchanged/case-insensitive accounts, foreign-listener preservation and cleanup, stale permission results, missing event support, silent account changes, provider replacement during an outstanding account read and callbacks from a replaced/disposed session. The provider is synthetic; the tests do not authenticate an extension implementation.

The existing real Chromium synthetic-sample test now emits account changes, a chain change while an ID HTTP response is held, and a disconnect with a private diagnostic marker. It checks cleared identity/consent/proofs, disabled bank/issuance actions, no automatic issue/resume, preserved recovery ID and rejection of the late ID success. The provider and APIs in that test are deliberate mocks. An initial harness assertion expected the original proof even after its own recovery fixture had created a new flow; that fixture expectation was corrected without weakening session checks.

## Remaining support work

The server still follows its EOA/65-byte signature path. Contract-wallet/multisig verification, wallet discovery/selection, mobile deep-link return, extension-specific permissions, automatic proof renewal and approved supported wallet/browser/language lists remain open. Manual expiry/reset and reconnection are implemented below. No claim of MetaMask, WalletConnect, hardware-wallet or mobile certification is made here. Provider replacement while idle is detected on the next check, not by a universal provider-discovery event. A provider that lies about accounts remains a trust problem; a never-resolving request now has a bounded local wait, not an extension cancellation guarantee.

No live wallet, bank, public chain or deployment was used for this change. The existing independent API/storage/EVM integration does not turn these mocked browser event tests into a combined end-to-end run.

## Wallet-control expiry and explicit reset

The sealed wallet token has a 30-minute lifetime, separate from the 10-minute SIWE signing challenge. Previously the response supplied no expiry to the page. `Signed` therefore remained indefinitely, and its disabled connect button prevented a new signature after the server rejected an expired token.

The wallet POST response now includes `walletExpiresAt` and `serverTime` as millisecond timestamps. The expiry comes from opening the actual just-sealed wallet token, not from a separately estimated timestamp. The server remains responsible for authenticating and expiring that opaque token. No client assertion, timer or clock change extends server authority.

The browser records wall and monotonic clock values before starting the signature-verification POST. It validates the response's positive, finite, representable expiry and remaining lifetime (no more than 30 minutes), then anchors that remaining duration at the **start** of the request. Provider/network/response time is subtracted conservatively rather than granting an extra client-side lifetime. Missing/invalid expiry, a response already past its local deadline or a clock earlier than the recorded start invalidates the local session. Server/browser clock offsets do not require equal absolute timestamps: duration is derived from the two server fields. These fields are response metadata, not an independently authenticated clock service.

Expiry is checked on a one-second page timer, window focus/visibility changes and all existing session checks before/after flow API and wallet awaits. Either wall or monotonic deadline can expire the session. A throttled or suspended timer is not claimed to run exactly on time; the next visibility/focus/check boundary enforces it before usable response state is restored. The existing revision fence discards late document/bank/issuance responses, clears usable local tokens/input/consent/results and removes this session's listeners. It does not cancel already dispatched requests, revoke still-valid server tokens, erase server records or undo a transaction.

The page distinguishes challenge and wallet-session lifetimes, displays the server expiry, and offers `Reset wallet session` when idle. Reset and expiry do not sign, submit, issue or recover automatically. Reconnection requires explicit sample selection/consent and a new wallet signature; document/account proofs belong to the old flow and must be acquired again for a new issuance. The original per-wallet recovery request ID remains in session storage, so a fresh same-wallet proof can still load the existing issuance without reusing old ID/bank proofs or issuing another mark. Loading a new synthetic preset discards the old local deadline along with its wallet proof; it does not retain an expiry callback that later clears the new preset.

Client and wallet API must be released together: a new client receiving an older response without expiry fails closed rather than inferring a new 30-minute session. Automatic renewal, server-side revocation of reset tokens, refresh-token design, precise cross-device clock behavior and real mobile wallet return testing are not implemented by this change.

### Expiry evidence

Three added root tests cover request-duration subtraction, exact deadline invalidation once, listener cleanup, missing/invalid/excessive expiry, delayed responses, wall/monotonic deadline or regression, expiry during a pending account read and isolation from a fresh authorization. The clock/provider are controlled fixtures.

One new actual wallet-route test signs a real synthetic EOA message, checks that the response expiry equals the decrypted server token expiry and retains no-store headers, then advances only its test clock and confirms the server rejects the expired token. It does not involve a browser extension or public chain.

The existing Chromium test supplies a short synthetic response lifetime while an ID HTTP response is held. Expiry removes `Signed`, clears the identity form and prevents the released late response from restoring a document result; it makes no additional API call and preserves the original recovery ID. Explicit sample/consent/signature afterward can load that original result without another issuance. Manual reset also makes no API call and preserves the recovery ID. The fixture's shortened lifetime is browser-only test data; the production API remains 30 minutes. The onchain and sanctions-training browser tests pass against the same rebuilt app. These are separate local checks, not a combined real-wallet/real-bank/public-chain journey.

## Bounded provider waits and explicit stop

Account permission and `personal_sign` requests now have a two-minute local wait limit; each `eth_accounts` read has ten seconds. Previously any one of these promises could leave the form busy indefinitely. All three use the same revision-bound request wrapper. It copies the method and parameter array before asynchronous dispatch, checks the current provider/session before dispatch and acceptance, and rejects a response whose wall or monotonic elapsed time has already reached the limit even if a suspended timer has not fired. Clock regression also rejects the response. These are local availability bounds, not an authenticated time service or a guaranteed timer schedule while the browser is suspended.

Session disposal immediately settles its outstanding local waits and clears their timeout timers. A disposed request not yet dispatched never calls the provider. Timeout invalidates the session once, clears the existing local flow state and consent, and requires explicit reconnection. While wallet work is busy, `Stop waiting` uses that same invalidation boundary. It does not silently retry permission, sign, submit a wallet proof or resume issuance. An eventual resolution or rejection of the original provider promise is consumed and cannot restore state, invoke the next flow step or invalidate a newly attached session. Request rejection uses a fixed notice rather than displaying extension diagnostics.

The page explicitly says stopping or timing out **does not cancel the wallet request**. An already opened extension prompt may remain, and the user must review or dismiss it before reconnecting. The wrapper cannot revoke permission, unsign a message, force an extension to close, interrupt synchronously blocking provider code, release a promise retained inside the extension, or undo already dispatched HTTP/chain work. The button covers local wallet work; separate HTTP timeout/abort behavior is not established by this provider change. No automatic retry or broad browser-provider compatibility claim is added.

### Provider-wait evidence

Three additional root tests cover all three hanging methods, single timeout notification/no replay, late success and rejection after a new session, disposal before and after dispatch, elapsed time before dispatch, response lateness/clock regression before the timer callback, private rejection diagnostics and caller mutation of method/parameters. Small injected timeout values are unit-test inputs; the production page uses the fixed defaults above. Two existing pending-account fixtures now wait for the wrapper's dispatch microtask before resolving their own mock promise.

The existing Chromium test adds four isolated synthetic-provider contexts: hung permission, hung account read, hung signature and explicit stop during signature. Each installs its own browser clock before page timers, advances it across the production limit, checks the alert/cleared consent/no wallet POST, then releases the old promise and checks that it still cannot authenticate. After stop, advancing beyond the old timeout does not replace the stop notice. A new explicit sample/consent/connect succeeds with the now-responsive fixture and exactly one verification POST. API responses and providers remain mocks; no actual extension, institution, wallet transaction or public deployment was exercised.
