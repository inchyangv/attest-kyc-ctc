pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/poseidon.circom";

// Experimental Groth16 statement for a four-leaf active credential set.
// The authenticated root is an external trust boundary enforced by the gate.
template KycPolicy() {
    // Public policy and presentation context.
    signal input root;
    signal input policyId;
    signal input allowedCountryA;
    signal input allowedCountryB;
    signal input maxBirthDay;
    signal input holder;
    signal input applicationId;
    signal input epoch;
    signal input deadline;

    // Private credential opening and Merkle membership witness.
    signal input secret;
    signal input country;
    signal input birthDay;
    signal input credentialExpiry;
    signal input credentialId;
    signal input siblings[2];
    signal input pathIndices[2];

    // Public, presentation-specific replay nullifier.
    signal output nullifier;

    component leafHash = Poseidon(6);
    leafHash.inputs[0] <== secret;
    leafHash.inputs[1] <== holder;
    leafHash.inputs[2] <== country;
    leafHash.inputs[3] <== birthDay;
    leafHash.inputs[4] <== credentialExpiry;
    leafHash.inputs[5] <== credentialId;

    signal merkleNodes[3];
    merkleNodes[0] <== leafHash.out;
    component levelHashers[2];
    signal left[2];
    signal right[2];
    for (var i = 0; i < 2; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;
        left[i] <== merkleNodes[i] + pathIndices[i] * (siblings[i] - merkleNodes[i]);
        right[i] <== siblings[i] + pathIndices[i] * (merkleNodes[i] - siblings[i]);
        levelHashers[i] = Poseidon(2);
        levelHashers[i].inputs[0] <== left[i];
        levelHashers[i].inputs[1] <== right[i];
        merkleNodes[i + 1] <== levelHashers[i].out;
    }
    merkleNodes[2] === root;

    component countryA = IsEqual();
    component countryB = IsEqual();
    countryA.in[0] <== country;
    countryA.in[1] <== allowedCountryA;
    countryB.in[0] <== country;
    countryB.in[1] <== allowedCountryB;
    countryA.out + countryB.out - countryA.out * countryB.out === 1;

    // Dates are integer days since Unix epoch. Earlier DOB means old enough.
    component ageCutoff = LessEqThan(32);
    ageCutoff.in[0] <== birthDay;
    ageCutoff.in[1] <== maxBirthDay;
    ageCutoff.out === 1;

    // The private credential itself must remain valid through the presentation.
    component credentialFresh = LessEqThan(64);
    credentialFresh.in[0] <== deadline;
    credentialFresh.in[1] <== credentialExpiry;
    credentialFresh.out === 1;

    // Canonical integer ranges prevent field aliases in credential/policy values.
    component holderBits = Num2Bits(160);
    component policyBits = Num2Bits(64);
    component countryABits = Num2Bits(16);
    component countryBBits = Num2Bits(16);
    component countryBits = Num2Bits(16);
    component birthBits = Num2Bits(32);
    component cutoffBits = Num2Bits(32);
    component credentialExpiryBits = Num2Bits(64);
    component credentialIdBits = Num2Bits(64);
    component epochBits = Num2Bits(64);
    component deadlineBits = Num2Bits(64);
    holderBits.in <== holder;
    policyBits.in <== policyId;
    countryABits.in <== allowedCountryA;
    countryBBits.in <== allowedCountryB;
    countryBits.in <== country;
    birthBits.in <== birthDay;
    cutoffBits.in <== maxBirthDay;
    credentialExpiryBits.in <== credentialExpiry;
    credentialIdBits.in <== credentialId;
    epochBits.in <== epoch;
    deadlineBits.in <== deadline;

    // Holder/application/policy/epoch/deadline are all cryptographically bound.
    component contextHash = Poseidon(5);
    contextHash.inputs[0] <== holder;
    contextHash.inputs[1] <== applicationId;
    contextHash.inputs[2] <== policyId;
    contextHash.inputs[3] <== epoch;
    contextHash.inputs[4] <== deadline;

    component nullifierHash = Poseidon(2);
    nullifierHash.inputs[0] <== secret;
    nullifierHash.inputs[1] <== contextHash.out;
    nullifier <== nullifierHash.out;
}

component main {public [root, policyId, allowedCountryA, allowedCountryB, maxBirthDay, holder, applicationId, epoch, deadline]} = KycPolicy();
