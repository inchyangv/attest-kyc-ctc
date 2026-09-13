# Experimental proving toolchain

This directory is a local Groth16 prototype, not a production ceremony or audited
credential system. The generated verifier and checked-in Solidity proof fixture
must always be updated as one pair after circuit or proving-key changes.

`npm audit --omit=dev` currently reports 15 low-severity advisories inherited
from `circomlibjs` through ethers v5 and `elliptic`. npm's proposed automatic fix
downgrades `circomlibjs` across a breaking boundary, so it is intentionally not
applied. Patchable `ws` and `underscore` advisories are pinned through package
overrides. No wallet signing or operational key material is handled here.
