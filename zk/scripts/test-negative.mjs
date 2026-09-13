import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";

const here = dirname(fileURLToPath(import.meta.url));
const zkRoot = resolve(here, "..");
const build = resolve(zkRoot, "build");
const inputPath = resolve(build, "fixture-input.json");
const wasm = resolve(build, "kyc_policy_js/kyc_policy.wasm");
const snarkjs = resolve(zkRoot, "node_modules/.bin/snarkjs");
const base = JSON.parse(readFileSync(inputPath, "utf8"));
const poseidon = await buildPoseidon();
const field = poseidon.F;
const hash = (values) => BigInt(field.toString(poseidon(values.map(BigInt))));

function withRecomputedRoot(changes) {
  const candidate = { ...base, ...changes };
  const leaf = hash([
    candidate.secret,
    candidate.holder,
    candidate.country,
    candidate.birthDay,
    candidate.credentialExpiry,
    candidate.credentialId
  ]);
  const parent = hash([leaf, candidate.siblings[0]]);
  candidate.root = hash([parent, candidate.siblings[1]]).toString();
  return candidate;
}

const invalidCases = [
  ["unsupported-country", withRecomputedRoot({ country: "840" })],
  ["underage", withRecomputedRoot({ birthDay: (BigInt(base.maxBirthDay) + 1n).toString() })],
  ["expired-credential", withRecomputedRoot({ credentialExpiry: (BigInt(base.deadline) - 1n).toString() })],
  ["not-in-active-root", { ...base, siblings: [(BigInt(base.siblings[0]) + 1n).toString(), base.siblings[1]] }]
];

for (const [name, candidate] of invalidCases) {
  const candidatePath = resolve(build, `${name}.json`);
  const witnessPath = resolve(build, `${name}.wtns`);
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  let rejected = false;
  try {
    execFileSync(snarkjs, ["wtns", "calculate", wasm, candidatePath, witnessPath], {
      cwd: zkRoot,
      stdio: "ignore"
    });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`circuit accepted invalid case: ${name}`);
  console.log(`rejected ${name}`);
}
