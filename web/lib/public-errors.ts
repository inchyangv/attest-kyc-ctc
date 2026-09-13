import 'server-only';
import { VendorError } from '@pipeline/adapters/kr.js';
import { VendorTransportError } from '@pipeline/adapters/vendor-http.js';
import { ConfigError } from './kyc-server';
import { privateJson } from './private-response';

const transportCodes = new Set(['VENDOR_TIMEOUT', 'VENDOR_CAPACITY', 'VENDOR_HTTP', 'VENDOR_RESPONSE_LIMIT',
  'VENDOR_BAD_RESPONSE', 'VENDOR_NETWORK', 'VENDOR_REQUEST_LIMIT']);
const localMessages: Record<string, string> = {
  BAD_BANK: 'Choose a supported Korean bank.',
  BAD_INPUT: 'Check the required identity fields and their format.',
  INVALID_IMAGE: 'Provide a supported JPEG or PNG document image.',
  NO_HOLDER: 'The bank could not confirm an account holder for the supplied details.',
  NO_CODE: 'The transfer result could not be confirmed. Do not automatically repeat the deposit.',
  DEMO_NO_NAME: 'The synthetic bank demo requires a declared name.',
};
const unavailableCodes = new Set(['NO_VENDOR', 'NO_OCR', 'NO_PUBLIC_KEY']);

/** Never serialize message/ref/cause/stack from a vendor, even for a recognized business code. */
export function publicVendorFailure(error: unknown): Response | null {
  if (!(error instanceof VendorError)) return null;
  if (error instanceof VendorTransportError) {
    return privateJson({ error: 'Institution request could not be confirmed; do not automatically repeat it.',
      code: transportCodes.has(error.code ?? '') ? error.code : 'VENDOR_NETWORK', outcome: 'unconfirmed', automaticRetry: false }, { status: 503 });
  }
  const rawCode = typeof error.code === 'string' ? error.code : '';
  if (unavailableCodes.has(rawCode)) return privateJson({ error: 'Institution verification is not available in this deployment.', code: 'VENDOR_UNAVAILABLE', ref: null }, { status: 503 });
  // Finite local meanings; provider code grammar conveys a code, never arbitrary free text.
  const local = Object.hasOwn(localMessages, rawCode) ? localMessages[rawCode] : undefined;
  const providerCode = /^(?:CF-\d{5}|[A-Z]\d{4}|\d{3})$/.test(rawCode);
  return privateJson({ error: local ?? 'The institution could not complete this check. Review the supplied details or contact the service operator.',
    code: local || providerCode ? rawCode : 'VENDOR_FAILURE', ref: null }, { status: 422 });
}

const publicConfigNames = new Set([
  'CODEF_ENV', 'CODEF_CLIENT_ID', 'CODEF_CLIENT_SECRET', 'CODEF_PUBLIC_KEY', 'CODEF_CERT_TYPE', 'CODEF_CERT_FILE',
  'CODEF_KEY_FILE', 'CODEF_CERT_PASSWORD', 'CODEF_LOGIN_TYPE', 'CODEF_SIMPLE_LEVEL', 'CODEF_LOGIN_PHONE',
  'CODEF_LOGIN_TELECOM', 'CODEF_LOGIN_USER_NAME', 'CODEF_LOGIN_IDENTITY', 'BANK_VENDOR',
  'OPENBANKING_ENV', 'OPENBANKING_CLIENT_ID', 'OPENBANKING_CLIENT_SECRET', 'OPENBANKING_CLIENT_USE_CODE', 'OPENBANKING_CNTR_ACCOUNT_NUM',
  'OPENBANKING_WD_PASS_PHRASE', 'BANK_STATE_REDIS_REST_URL', 'BANK_STATE_REDIS_REST_TOKEN', 'BANK_STATE_NAMESPACE',
  'EVIDENCE_HMAC_KEY', 'EVIDENCE_VAULT_PATH', 'EVIDENCE_VAULT_KEY',
  'SERVER_TOKEN_KEY', 'SERVER_TOKEN_KEY_ID', 'SERVER_TOKEN_PREVIOUS_KEY', 'SERVER_TOKEN_PREVIOUS_KEY_ID',
  'SERVER_TOKEN_PREVIOUS_ACCEPT_UNTIL',
  'PROCESSING_POLICY_JSON', 'RETENTION_POLICY_JSON',
  'ISSUANCE_JOURNAL_REDIS_REST_URL', 'ISSUANCE_JOURNAL_REDIS_REST_TOKEN', 'ISSUANCE_JOURNAL_KEY',
  'ISSUANCE_GAS_BUDGET_KEY', 'ISSUANCE_DAILY_GAS_LIMIT', 'ISSUANCE_DAILY_TRANSACTION_LIMIT',
  'ISSUER_PRIVATE_KEY', 'NEXT_PUBLIC_SOURCE', 'NEXT_PUBLIC_ASC', 'NEXT_PUBLIC_SEPOLIA_RPC', 'NEXT_PUBLIC_CC3_RPC',
]);

export function publicConfigFailure(error: unknown, requestId?: string): Response | null {
  if (!(error instanceof ConfigError)) return null;
  const missing = Array.isArray(error.missing) ? [...new Set(error.missing.filter(name => publicConfigNames.has(name)))] : [];
  return privateJson({ error: 'Required service configuration is unavailable.', code: 'CONFIGURATION_UNAVAILABLE', missing,
    ...(requestId && /^0x[0-9a-fA-F]{64}$/.test(requestId) ? { requestId } : {}) }, { status: 503 });
}
