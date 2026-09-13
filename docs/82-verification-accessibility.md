# T-38 — Verification controls and tested accessibility scope

2026-09-07. This is a local interface improvement and browser test record, not an accessibility certification or a declaration that mobile wallets, contract wallets or every browser are supported.

## Changed behavior

The document selector used `tablist`/`tab` roles without tab panels or the expected keyboard selection behavior. It is now a native fieldset with a Document legend and two labelled radio inputs. Native keyboard navigation changes the selected type and corresponding fields. The whole fieldset remains disabled before wallet control, after document verification and in the preset-only synthetic flow. The change does not grant access to institutional calls or enable personal document entry in synthetic mode.

The global CSS rule removing focus outlines from every input was removed. Existing `:focus-visible` styling now also applies to checkboxes, radios and file inputs. Document choices remain visibly selected independently of the focus outline. No automatic wallet request or API submission was added to focus, selection or consent changes.

Verification steps now have real level-2 headings and named regions, with textual ready/waiting/completed states. Step errors and configuration errors use persistent alert regions; in-progress operations update a polite status region. These provide programmatic notification hooks without forcing focus away from the user's current input. The error message remains visible text rather than only a color/icon. Existing server request, wallet revision and recovery behavior are unchanged.

The wallet section now explicitly describes the implemented boundary: externally owned accounts through an injected provider with account/network/disconnect event support. Contract-wallet/multisig verification is not supported by this flow. Mobile wallet return behavior has not been validated. This describes the current implementation, not a product decision to exclude those users permanently or a finding that an unsupported wallet failed identity verification.

## Executed local checks

The existing synthetic Chromium test runs the production web build at a 390×844 viewport with intercepted synthetic wallet/vendor/config APIs. It now checks:

- Enter activates sample selection without wallet/vendor/issuance calls. Space toggles consent with a visible focus outline, also without an API/signature request.
- Steps are accessible by their headings/region names; document radios remain disabled in synthetic mode.
- In a separate synthetic non-demo configuration, after simulated wallet control, ArrowRight/ArrowLeft switch the native document radio and visible fields. Focus follows the selected radio. Tab leaves the group for the file input, whose outline is visible. No document is uploaded and no institution is called in that branch.
- The simulated bank holder mismatch appears in one alert region; a deliberately held document request exposes the polite busy status. Existing account/chain/disconnect and late-response clearing tests continue to pass.
- The sampled mobile document has no horizontal page overflow. Screenshots capture the synthetic mobile page and focused document selector. The first run's images at `artifacts/verify-accessibility-ot4o8s/` were visually inspected; the focused selector shows the selected radio and mint outline without clipping. Each rerun creates a new uniquely named ignored artifact directory.

Web lint and production build passed after removing an unused import introduced by the selector change. The onchain and sanctions-training Chromium tests also passed against that build. No additional test-suite count is claimed for assertions added to the existing synthetic test.

## Still unverified

| Area | Evidence boundary |
|---|---|
| Real EOA wallet signatures / wallet return | Provider and signatures are mocked in the browser test; real wallet/device testing remains required |
| iOS Safari, Android wallet browsers, Firefox | Not run; a narrow Chromium viewport is not a physical mobile device |
| VoiceOver, NVDA, TalkBack announcements | Semantic DOM regions tested, actual speech/order and assistive-technology interaction not tested |
| Zoom, text scaling, contrast, target sizes, reduced motion | No complete audit performed; absence of horizontal overflow at one viewport is insufficient |
| Captcha/certificate application handoff | Institutional continuation and accessible alternatives need approved vendor/device testing |
| Contract wallets / multisig | Not implemented by this wallet-control flow; requires an explicit product scope and verification design |

Do not replace these gaps with a blanket WCAG pass, support matrix approval or completed T-38 status. No public deployment, real personal data, bank action, wallet signature or onchain issuance was performed by these tests.
