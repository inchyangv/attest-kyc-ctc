import { assertIssuerReleaseProfile, CURRENT_ISSUER_SCOPE_VERSION } from '../pipeline/issuer-isolation.js';

const [mode, stableIssuer] = process.argv.slice(2);

try {
  assertIssuerReleaseProfile({
    mode,
    stableIssuers: stableIssuer ? [stableIssuer] : [],
    policyIssuers: stableIssuer ? [stableIssuer] : [],
  });
  console.log(`PASS issuer release guard: mode=${mode}; scopeVersion=${CURRENT_ISSUER_SCOPE_VERSION}; one pinned stable issuer`);
} catch (error) {
  console.error(`BLOCK issuer release guard: ${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}`);
  process.exitCode = 1;
}
