import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const zkRoot = resolve(here, "..");
const build = resolve(zkRoot, "build");
const circuit = resolve(zkRoot, "circuits/kyc_policy.circom");
const bin = (name) => resolve(zkRoot, `node_modules/.bin/${name}`);
const run = (name, args) => execFileSync(bin(name), args, { cwd: zkRoot, stdio: "inherit" });

rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
run("circom2", [circuit, "--r1cs", "--wasm", "--sym", "-o", build]);
run("snarkjs", ["powersoftau", "new", "bn128", "12", resolve(build, "pot12_0000.ptau")]);
run("snarkjs", ["powersoftau", "contribute", resolve(build, "pot12_0000.ptau"), resolve(build, "pot12_0001.ptau"), "--name=proofmark-local-fixture", "-e=proofmark-experimental-reproducible-fixture"]);
run("snarkjs", ["powersoftau", "prepare", "phase2", resolve(build, "pot12_0001.ptau"), resolve(build, "pot12_final.ptau")]);
run("snarkjs", ["groth16", "setup", resolve(build, "kyc_policy.r1cs"), resolve(build, "pot12_final.ptau"), resolve(build, "kyc_policy_0000.zkey")]);
run("snarkjs", ["zkey", "contribute", resolve(build, "kyc_policy_0000.zkey"), resolve(build, "kyc_policy_final.zkey"), "--name=proofmark-local-fixture", "-e=proofmark-experimental-reproducible-zkey"]);
run("snarkjs", ["zkey", "export", "verificationkey", resolve(build, "kyc_policy_final.zkey"), resolve(build, "verification_key.json")]);
run("snarkjs", ["zkey", "export", "solidityverifier", resolve(build, "kyc_policy_final.zkey"), resolve(build, "KycPolicyGroth16Verifier.sol")]);

if (!existsSync(resolve(build, "KycPolicyGroth16Verifier.sol"))) {
  throw new Error("Solidity verifier was not generated");
}
