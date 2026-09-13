import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";

const here = dirname(fileURLToPath(import.meta.url));
const zkRoot = resolve(here, "..");
const build = resolve(zkRoot, "build");
const poseidon = await buildPoseidon();
const field = poseidon.F;
const hash = (values) => BigInt(field.toString(poseidon(values.map(BigInt))));

const holder = BigInt("0x00000000000000000000000000000000000a11ce");
const secret = 112233445566778899n;
const country = 410n; // KR, private witness
const birthDay = 10000n; // private witness
const credentialExpiry = 2100000000n; // private credential validity
const credentialId = 9001n;
const leaf = hash([secret, holder, country, birthDay, credentialExpiry, credentialId]);
const sibling0 = hash([41n, 42n, 43n, 44n, 45n, 46n]);
const sibling1 = hash([hash([51n, 52n, 53n, 54n, 55n, 56n]), hash([61n, 62n, 63n, 64n, 65n, 66n])]);
const parent = hash([leaf, sibling0]);
const root = hash([parent, sibling1]);

const input = {
  root: root.toString(),
  policyId: "20260910",
  allowedCountryA: "410",
  allowedCountryB: "392",
  maxBirthDay: "13949",
  holder: holder.toString(),
  // Local Foundry fixture: chain 31337 + gate 0x2e234D... + "proofmark.subscribe".
  // Production proof builders must query gate.expectedApplicationId().
  applicationId: "3250162062533471447538495730628722666881011379663305981082613662888375706148",
  epoch: "7",
  deadline: "2000000000",
  secret: secret.toString(),
  country: country.toString(),
  birthDay: birthDay.toString(),
  credentialExpiry: credentialExpiry.toString(),
  credentialId: credentialId.toString(),
  siblings: [sibling0.toString(), sibling1.toString()],
  pathIndices: ["0", "0"]
};

mkdirSync(build, { recursive: true });
writeFileSync(resolve(build, "fixture-input.json"), `${JSON.stringify(input, null, 2)}\n`);
execFileSync(
  resolve(zkRoot, "node_modules/.bin/snarkjs"),
  ["groth16", "fullprove", resolve(build, "fixture-input.json"), resolve(build, "kyc_policy_js/kyc_policy.wasm"), resolve(build, "kyc_policy_final.zkey"), resolve(build, "proof.json"), resolve(build, "public.json")],
  { cwd: zkRoot, stdio: "inherit" }
);

const proof = JSON.parse(readFileSync(resolve(build, "proof.json"), "utf8"));
const publicSignals = JSON.parse(readFileSync(resolve(build, "public.json"), "utf8"));
writeFileSync(resolve(build, "solidity-fixture.json"), `${JSON.stringify({ proof, publicSignals }, null, 2)}\n`);
console.log(JSON.stringify({ root: root.toString(), publicSignals }, null, 2));
