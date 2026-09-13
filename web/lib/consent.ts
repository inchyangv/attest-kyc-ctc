/** Shared verbatim by the displayed notice and the server's EIP-4361 statement. */
export const CONSENT_VERSION = 'proofmark-kyc-v4-synthetic';
/** Compatibility/default text for the built-in synthetic policy. Production SIWE text is generated
 * from the approved PROCESSING_POLICY_JSON and returned by the status/wallet endpoints. */
export const SIWE_STATEMENT = 'Proofmark notice proofmark-kyc-v4-synthetic: policy proofmark-synthetic-processing-v1; model first-party; controller proofmark-demo; recipients proofmark:web,demo:id,demo:bank,proofmark:issuer,proofmark:journal,public:blockchains; locations KR,GLOBAL; synthetic RRN fixture only; rights rights:synthetic-demo:v1; retention follows each approved flow; wallet-linked metadata and commitments are published irreversibly on ethereum-sepolia,creditcoin-cc3.';
