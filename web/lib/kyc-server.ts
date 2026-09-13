/**
 * Server side of the verification flow.
 *
 *  - builds the KR adapter from the environment: CODEF for the ID document, CODEF or KFTC Open
 *    Banking for the bank account. No vendor means no adapter, and the API says which variables
 *    are missing. There is no mock to fall back to.
 *  - seals the state that has to cross the browser between steps (the ID result, the one-won
 *    challenge, the wallet proof) with AES-256-GCM under a dedicated, versioned server-token key.
 *    The browser holds an opaque token, never the holder name or the code.
 *  - builds and checks the EIP-4361 message for wallet control.
 */
import 'server-only';
import { SIWE_STATEMENT } from './consent';
export { CONSENT_VERSION, SIWE_STATEMENT } from './consent';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { KrAdapter, type BankAccountVendor, type IdDocumentVendor } from '@pipeline/adapters/kr.js';
import { CodefClient, CodefIdDocumentVendor, CodefBankAccountVendor, type CodefEnv, type CodefLogin } from '@pipeline/adapters/codef.js';
import { OpenBankingAccountVendor, type OpenBankingEnv } from '@pipeline/adapters/openbanking.js';
import { DemoIdDocumentVendor, DemoBankAccountVendor } from '@pipeline/adapters/demo.js';
import type { ProcessingPolicyBindingV1 } from '@pipeline/privacy-processing-policy.js';
import type { RetentionPolicyBindingV1 } from '@pipeline/retention-policy.js';

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

/**
 * KYC_DEMO=1: an axis with no real vendor gets the demo vendor, and results that are not live
 * (demo, sandbox, testbed) still set their bits unless KYC_DEMO_BITS=0. The mark carries regime
 * sandbox and the evidence names the demo vendor. Never set in production.
 */
export const isDemo = () => env('KYC_DEMO') === '1';
export const demoBits = () => isDemo() && env('KYC_DEMO_BITS') !== '0';

export class ConfigError extends Error {
  constructor(message: string, readonly missing: string[]) { super(message); this.name = 'ConfigError'; }
}
export class TokenError extends Error {
  constructor(message: string) { super(message); this.name = 'TokenError'; }
}

export interface FlowBinding {
  flowId: string;
  walletAddress: string;
}

export interface WalletFlow {
  address: string;
  flowId: string;
  consentVersion: string;
  consentStatementHash: string;
  processingPolicy: ProcessingPolicyBindingV1;
  retentionPolicy: RetentionPolicyBindingV1;
  at: number;
}

// ─── vendors ───────────────────────────────────────────────────────────────

const CODEF_CLIENT_VARS = ['CODEF_CLIENT_ID', 'CODEF_CLIENT_SECRET', 'CODEF_PUBLIC_KEY'];
const CODEF_CERT_VARS = ['CODEF_CERT_FILE', 'CODEF_CERT_PASSWORD', 'CODEF_LOGIN_USER_NAME', 'CODEF_LOGIN_IDENTITY'];
const CODEF_SIMPLE_VARS = ['CODEF_LOGIN_PHONE', 'CODEF_LOGIN_USER_NAME', 'CODEF_LOGIN_IDENTITY'];
const OPENBANKING_VARS = ['OPENBANKING_CLIENT_ID', 'OPENBANKING_CLIENT_SECRET', 'OPENBANKING_CLIENT_USE_CODE',
                          'OPENBANKING_CNTR_ACCOUNT_NUM', 'OPENBANKING_WD_PASS_PHRASE'];

export interface SideStatus {
  configured: boolean;
  vendor: string | null;
  live: boolean;
  /** The demo vendor stands in for a real one on this axis */
  demo: boolean;
  env: string | null;
  missing: string[];
  error?: string;
}
export interface VendorStatus {
  demo: boolean;
  sandboxBits: boolean;
  id: SideStatus;
  bank: SideStatus;
  issuer: { configured: boolean; address: string | null; missing: string[] };
}

const unconfigured = (e: string | null, missing: string[], error?: string): SideStatus =>
  ({ configured: false, vendor: null, live: false, demo: false, env: e && ['sandbox', 'demo', 'api', 'test', 'prod'].includes(e) ? e : null, missing, error });

let codefClient: CodefClient | null = null;
function codef(): CodefClient {
  if (codefClient) return codefClient;
  const missing = CODEF_CLIENT_VARS.filter((v) => !env(v));
  if (missing.length) throw new ConfigError('CODEF client is not configured', missing);
  const e = (env('CODEF_ENV') ?? 'demo') as CodefEnv;
  if (!['sandbox', 'demo', 'api'].includes(e)) throw new ConfigError('CODEF_ENV must be sandbox, demo or api', ['CODEF_ENV']);
  codefClient = new CodefClient({ clientId: env('CODEF_CLIENT_ID')!, clientSecret: env('CODEF_CLIENT_SECRET')!, publicKey: env('CODEF_PUBLIC_KEY'), env: e });
  return codefClient;
}

function codefLogin(): { login: CodefLogin | null; missing: string[] } {
  const kind = env('CODEF_LOGIN_TYPE') ?? 'cert';
  if (kind === 'simple') {
    const missing = CODEF_SIMPLE_VARS.filter((v) => !env(v));
    const level = env('CODEF_SIMPLE_LEVEL') ?? '1';
    if (level === '5' && !env('CODEF_LOGIN_TELECOM')) missing.push('CODEF_LOGIN_TELECOM');
    if (missing.length) return { login: null, missing };
    return { missing: [], login: {
      kind: 'simple', level, phoneNo: env('CODEF_LOGIN_PHONE')!, telecom: env('CODEF_LOGIN_TELECOM') as '0' | '1' | '2' | undefined,
      loginUserName: env('CODEF_LOGIN_USER_NAME')!, loginIdentity: env('CODEF_LOGIN_IDENTITY')!.replace(/\D/g, ''),
    } };
  }
  const missing = CODEF_CERT_VARS.filter((v) => !env(v));
  const certType = (env('CODEF_CERT_TYPE') ?? 'pfx') as '1' | 'pfx';
  if (certType === '1' && !env('CODEF_KEY_FILE')) missing.push('CODEF_KEY_FILE');
  if (missing.length) return { login: null, missing };
  return { missing: [], login: {
    kind: 'cert', certType, certFile: env('CODEF_CERT_FILE')!, keyFile: env('CODEF_KEY_FILE'), certPassword: env('CODEF_CERT_PASSWORD')!,
    loginUserName: env('CODEF_LOGIN_USER_NAME')!, loginIdentity: env('CODEF_LOGIN_IDENTITY')!,
  } };
}

function buildIdVendor(): { vendor: IdDocumentVendor | null; status: SideStatus } {
  const e = env('CODEF_ENV') ?? 'demo';
  const login = codefLogin();
  const missing = [...CODEF_CLIENT_VARS.filter((v) => !env(v)), ...login.missing];
  if (missing.length || !login.login) {
    if (isDemo()) {
      const vendor = new DemoIdDocumentVendor();
      return { vendor, status: { configured: true, vendor: vendor.name, live: false, demo: true, env: 'demo', missing } };
    }
    return { vendor: null, status: unconfigured(e, missing) };
  }
  try {
    const vendor = new CodefIdDocumentVendor(codef(), login.login);
    return { vendor, status: { configured: true, vendor: `${vendor.name}:${vendor.loginKind}`, live: vendor.live, demo: false, env: e, missing: [] } };
  } catch {
    return { vendor: null, status: unconfigured(e, [], 'ID vendor configuration is invalid.') };
  }
}

function buildBankVendor(): { vendor: BankAccountVendor | null; status: SideStatus } {
  const which = env('BANK_VENDOR') ?? 'openbanking';
  const demoFallback = (missing: string[], error?: string) => {
    if (isDemo()) {
      const vendor = new DemoBankAccountVendor();
      return { vendor, status: { configured: true, vendor: vendor.name, live: false, demo: true, env: 'demo', missing, error } };
    }
    return { vendor: null, status: unconfigured(which === 'codef' ? env('CODEF_ENV') ?? 'demo' : env('OPENBANKING_ENV') ?? 'test', missing, error) };
  };
  if (which === 'codef') {
    const missing = CODEF_CLIENT_VARS.filter((v) => !env(v));
    if (missing.length) return demoFallback(missing);
    try {
      const vendor = new CodefBankAccountVendor(codef());
      return { vendor, status: { configured: true, vendor: vendor.name, live: true, demo: false, env: env('CODEF_ENV') ?? 'demo', missing: [] } };
    } catch {
      return demoFallback(['CODEF_ENV'], 'The configured bank product is unavailable in this environment.');
    }
  }
  if (which !== 'openbanking') {
    return { vendor: null, status: unconfigured(null, ['BANK_VENDOR'], 'BANK_VENDOR must be openbanking or codef') };
  }
  const missing = OPENBANKING_VARS.filter((v) => !env(v));
  const e = (env('OPENBANKING_ENV') ?? 'test') as OpenBankingEnv;
  if (e !== 'test' && e !== 'prod') return { vendor: null, status: unconfigured(null, ['OPENBANKING_ENV'], 'OPENBANKING_ENV must be test or prod') };
  if (missing.length) return demoFallback(missing);
  try {
    const vendor = new OpenBankingAccountVendor({
      clientId: env('OPENBANKING_CLIENT_ID')!, clientSecret: env('OPENBANKING_CLIENT_SECRET')!,
      clientUseCode: env('OPENBANKING_CLIENT_USE_CODE')!,
      cntrAccountType: (env('OPENBANKING_CNTR_ACCOUNT_TYPE') as 'N' | 'C' | undefined) ?? 'N',
      cntrAccountNum: env('OPENBANKING_CNTR_ACCOUNT_NUM')!,
      wdPassPhrase: env('OPENBANKING_WD_PASS_PHRASE')!,
      printName: env('OPENBANKING_PRINT_NAME'),
      env: e === 'prod' ? 'prod' : 'test',
    });
    return { vendor, status: { configured: true, vendor: vendor.name, live: vendor.live, demo: false, env: e, missing: [] } };
  } catch {
    return { vendor: null, status: unconfigured(e, [], 'Bank vendor configuration is invalid.') };
  }
}

let built: { adapter: KrAdapter; status: VendorStatus } | null = null;

/** The adapter with whatever vendors the environment names. Cached: the CODEF token lives in the client. */
export function getAdapter(): { adapter: KrAdapter; status: VendorStatus } {
  if (built) return built;
  const id = buildIdVendor();
  const bank = buildBankVendor();
  const issuerMissing = ['ISSUER_PRIVATE_KEY', 'NEXT_PUBLIC_SEPOLIA_RPC', 'NEXT_PUBLIC_SOURCE'].filter((v) => !env(v));
  built = {
    adapter: new KrAdapter(id.vendor, bank.vendor, { sandboxBits: demoBits() }),
    status: {
      demo: isDemo(),
      sandboxBits: demoBits(),
      id: id.status,
      bank: bank.status,
      issuer: { configured: issuerMissing.length === 0, address: env('NEXT_PUBLIC_SOURCE') ?? null, missing: issuerMissing },
    },
  };
  return built;
}

export function requireIdVendor(): KrAdapter {
  const { adapter, status } = getAdapter();
  if (!adapter.idVendor) throw new ConfigError(status.id.error ?? 'The ID document vendor is not configured', status.id.missing);
  return adapter;
}
export function requireBankVendor(): KrAdapter {
  const { adapter, status } = getAdapter();
  if (!adapter.bankVendor) throw new ConfigError(status.bank.error ?? 'The bank account vendor is not configured', status.bank.missing);
  return adapter;
}

// ─── sealed tokens ─────────────────────────────────────────────────────────

type TokenKey = { id: string; key: Buffer };
type TokenKeyRing = { current: TokenKey; previous?: TokenKey & { acceptUntil: number } };
const TOKEN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function tokenKey(secret: string, id: string): TokenKey {
  if (secret.length < 32) throw new ConfigError('server token keys must be at least 32 characters', ['SERVER_TOKEN_KEY']);
  if (!TOKEN_ID.test(id)) throw new ConfigError('server token key IDs must be opaque identifiers', ['SERVER_TOKEN_KEY_ID']);
  return { id, key: createHash('sha256').update(`${secret}|proofmark-server-token-v1`).digest() };
}

function tokenKeyRing(): TokenKeyRing {
  const currentSecret = env('SERVER_TOKEN_KEY'), currentId = env('SERVER_TOKEN_KEY_ID');
  const missing = ['SERVER_TOKEN_KEY', 'SERVER_TOKEN_KEY_ID'].filter(name => !env(name));
  if (missing.length || !currentSecret || !currentId) {
    throw new ConfigError('a dedicated server token key and key ID are required', missing);
  }
  for (const other of ['EVIDENCE_HMAC_KEY', 'EVIDENCE_VAULT_KEY', 'ISSUANCE_JOURNAL_KEY']) {
    if (env(other) === currentSecret) throw new ConfigError('server token custody must be independent', ['SERVER_TOKEN_KEY', other]);
  }
  const current = tokenKey(currentSecret, currentId);
  const previousSecret = env('SERVER_TOKEN_PREVIOUS_KEY'), previousId = env('SERVER_TOKEN_PREVIOUS_KEY_ID');
  const previousUntilText = env('SERVER_TOKEN_PREVIOUS_ACCEPT_UNTIL');
  const previousValues = [previousSecret, previousId, previousUntilText].filter(Boolean).length;
  if (previousValues === 0) return { current };
  if (previousValues !== 3 || !previousSecret || !previousId || !previousUntilText) {
    throw new ConfigError('the previous token key, ID and acceptance deadline must be configured together',
      ['SERVER_TOKEN_PREVIOUS_KEY', 'SERVER_TOKEN_PREVIOUS_KEY_ID', 'SERVER_TOKEN_PREVIOUS_ACCEPT_UNTIL']);
  }
  if (previousSecret === currentSecret || previousId === currentId) {
    throw new ConfigError('token rotation requires distinct current and previous keys and IDs',
      ['SERVER_TOKEN_KEY', 'SERVER_TOKEN_KEY_ID', 'SERVER_TOKEN_PREVIOUS_KEY', 'SERVER_TOKEN_PREVIOUS_KEY_ID']);
  }
  for (const other of ['EVIDENCE_HMAC_KEY', 'EVIDENCE_VAULT_KEY', 'ISSUANCE_JOURNAL_KEY']) {
    if (env(other) === previousSecret) throw new ConfigError('server token custody must be independent', ['SERVER_TOKEN_PREVIOUS_KEY', other]);
  }
  if (!/^\d+$/.test(previousUntilText)) throw new ConfigError('previous token acceptance deadline must be Unix milliseconds', ['SERVER_TOKEN_PREVIOUS_ACCEPT_UNTIL']);
  const acceptUntil = Number(previousUntilText);
  if (!Number.isSafeInteger(acceptUntil) || acceptUntil < 0) throw new ConfigError('previous token acceptance deadline is out of range', ['SERVER_TOKEN_PREVIOUS_ACCEPT_UNTIL']);
  return { current, previous: { ...tokenKey(previousSecret, previousId), acceptUntil } };
}

export function serverTokenStatus(): { configured: boolean; mode: 'versioned-dedicated' | 'none'; missing: string[];
  currentKeyId?: string; previousKeyId?: string; previousAcceptedUntil?: number } {
  try {
    const ring = tokenKeyRing();
    return { configured: true, mode: 'versioned-dedicated', missing: [], currentKeyId: ring.current.id,
      ...(ring.previous ? { previousKeyId: ring.previous.id, previousAcceptedUntil: ring.previous.acceptUntil } : {}) };
  } catch (error) {
    return { configured: false, mode: 'none', missing: error instanceof ConfigError ? error.missing : [] };
  }
}

const tokenAad = (id: string): Buffer => Buffer.from(`proofmark-server-token-v1\0${id}`);

/** Encrypt-and-authenticate `payload` under a type tag with a lifetime. Opaque to the browser. */
export function seal(typ: string, payload: object, ttlSec: number): string {
  const active = tokenKeyRing().current;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', active.key, iv);
  c.setAAD(tokenAad(active.id));
  const pt = Buffer.from(JSON.stringify({ ...payload, typ, exp: Date.now() + ttlSec * 1000 }), 'utf8');
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return `pm1.${Buffer.from(active.id).toString('base64url')}.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}

export function open<T extends object>(typ: string, token: unknown): T & { exp: number } {
  if (typeof token !== 'string' || token.length < 40) throw new TokenError(`missing ${typ} token`);
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'pm1') throw new TokenError(`malformed ${typ} token`);
  let id: string;
  try { id = Buffer.from(parts[1], 'base64url').toString('utf8'); }
  catch { throw new TokenError(`malformed ${typ} token`); }
  if (!TOKEN_ID.test(id) || Buffer.from(id).toString('base64url') !== parts[1]) throw new TokenError(`malformed ${typ} token`);
  const ring = tokenKeyRing(), now = Date.now();
  const selected = id === ring.current.id ? ring.current
    : ring.previous && id === ring.previous.id && now <= ring.previous.acceptUntil ? ring.previous : undefined;
  if (!selected) throw new TokenError(`${typ} token key is not accepted`);
  const buf = Buffer.from(parts[2], 'base64url');
  if (buf.length < 29) throw new TokenError(`malformed ${typ} token`);
  const d = createDecipheriv('aes-256-gcm', selected.key, buf.subarray(0, 12));
  d.setAAD(tokenAad(selected.id));
  d.setAuthTag(buf.subarray(12, 28));
  let pt: Buffer;
  try { pt = Buffer.concat([d.update(buf.subarray(28)), d.final()]); } catch { throw new TokenError(`${typ} token failed authentication`); }
  const j = JSON.parse(pt.toString('utf8')) as T & { typ: string; exp: number };
  if (j.typ !== typ) throw new TokenError(`expected a ${typ} token, got ${j.typ}`);
  if (typeof j.exp !== 'number' || j.exp < Date.now()) throw new TokenError(`${typ} token expired; start the step again`);
  return j;
}

export function flowFromWalletToken(token: unknown): WalletFlow & { exp: number } {
  const flow = open<WalletFlow>('wallet', token);
  if (!flow.flowId || !flow.address || !flow.processingPolicy
    || flow.processingPolicy.schema !== 'proofmark-processing-policy-binding-v1'
    || !flow.retentionPolicy || flow.retentionPolicy.schema !== 'proofmark-retention-policy-binding-v1'
    || !/^0x[0-9a-fA-F]{64}$/.test(flow.consentStatementHash)
    || flow.consentVersion !== flow.processingPolicy.noticeVersion) {
    throw new TokenError('wallet token has no current flow and consent binding');
  }
  return flow;
}

export function flowBinding(flow: WalletFlow): FlowBinding {
  return { flowId: flow.flowId, walletAddress: flow.address };
}

export function assertSameFlow(flow: WalletFlow, proof: FlowBinding, label: string): void {
  if (proof.flowId !== flow.flowId || proof.walletAddress?.toLowerCase() !== flow.address.toLowerCase()) {
    throw new TokenError(`${label} token belongs to a different wallet verification flow`);
  }
}

/** Keyed digest of the one-won code, so the challenge token can carry it without carrying it. */
export function codeDigest(code: string): string {
  return createHmac('sha256', tokenKeyRing().current.key).update(`code|${code.trim()}`).digest('hex');
}
export function codeMatches(code: string, digest: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(digest)) return false;
  const ring = tokenKeyRing(), now = Date.now();
  const candidates = [ring.current, ...(ring.previous && now <= ring.previous.acceptUntil ? [ring.previous] : [])];
  const expected = Buffer.from(digest, 'hex');
  return candidates.some(candidate => {
    const actual = createHmac('sha256', candidate.key).update(`code|${code.trim()}`).digest();
    return timingSafeEqual(actual, expected);
  });
}

// ─── EIP-4361 ──────────────────────────────────────────────────────────────

export interface SiweFields {
  domain: string;
  address: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  /** Exact structured-policy binding and generated notice carried in the sealed challenge. */
  processingPolicy?: ProcessingPolicyBindingV1;
  retentionPolicy?: RetentionPolicyBindingV1;
  statement?: string;
}

export const SIWE_CHAIN_ID = 11155111;

export function siweMessage(f: SiweFields): string {
  return [
    `${f.domain} wants you to sign in with your Ethereum account:`,
    f.address,
    '',
    f.statement ?? SIWE_STATEMENT,
    '',
    `URI: ${f.uri}`,
    'Version: 1',
    `Chain ID: ${SIWE_CHAIN_ID}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
  ].join('\n');
}

export const newNonce = () => randomBytes(12).toString('hex');

/** Mask a person's name for display: first and last character kept. */
export function maskName(name: string): string {
  const s = name.trim();
  if (s.length <= 1) return '*';
  if (s.length === 2) return `${s[0]}*`;
  return `${s[0]}${'*'.repeat(s.length - 2)}${s[s.length - 1]}`;
}
