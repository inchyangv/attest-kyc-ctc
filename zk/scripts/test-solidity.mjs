import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const zkRoot = resolve(here, "..");
const build = resolve(zkRoot, "build");
const smoke = resolve(build, "solidity-smoke");
const proof = JSON.parse(readFileSync(resolve(build, "proof.json"), "utf8"));
const signals = JSON.parse(readFileSync(resolve(build, "public.json"), "utf8"));
const u = (value) => `uint256(${value})`;

const a = `[${u(proof.pi_a[0])}, ${u(proof.pi_a[1])}]`;
const b = `[[${u(proof.pi_b[0][1])}, ${u(proof.pi_b[0][0])}], [${u(proof.pi_b[1][1])}, ${u(proof.pi_b[1][0])}]]`;
const c = `[${u(proof.pi_c[0])}, ${u(proof.pi_c[1])}]`;
const publicSignals = `[${signals.map(u).join(", ")}]`;

rmSync(smoke, { recursive: true, force: true });
mkdirSync(resolve(smoke, "src"), { recursive: true });
mkdirSync(resolve(smoke, "test"), { recursive: true });
cpSync(resolve(build, "KycPolicyGroth16Verifier.sol"), resolve(smoke, "src/KycPolicyGroth16Verifier.sol"));
writeFileSync(
  resolve(smoke, "foundry.toml"),
  `[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nsolc_version = "0.8.30"\nevm_version = "shanghai"\n`
);
writeFileSync(
  resolve(smoke, "test/FreshProof.t.sol"),
  `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Groth16Verifier} from "../src/KycPolicyGroth16Verifier.sol";

contract FreshProofTest {
    function test_FreshlyGeneratedProofExecutesInSolidity() public {
        Groth16Verifier verifier = new Groth16Verifier();
        uint256[2] memory a = ${a};
        uint256[2][2] memory b = ${b};
        uint256[2] memory c = ${c};
        uint256[10] memory publicSignals = ${publicSignals};
        require(verifier.verifyProof(a, b, c, publicSignals), "fresh Groth16 proof rejected");
        publicSignals[7] += 1;
        require(!verifier.verifyProof(a, b, c, publicSignals), "tampered public context accepted");
    }
}
`
);

execFileSync("forge", ["test", "--root", smoke, "-vv"], { cwd: zkRoot, stdio: "inherit" });
