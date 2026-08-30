/**
 * Server side of the verification flow.
 *
 *  - builds the KR adapter from the environment: CODEF for the ID document, CODEF or KFTC Open
 *    Banking for the bank account. No vendor means no adapter, and the API says which variables
 *    are missing. There is no mock to fall back to.
 *  - seals the state that has to cross the browser between steps (the ID result, the one-won
 *    challenge, the wallet proof) with AES-256-GCM under a key derived from EVIDENCE_HMAC_KEY.
 *    The browser holds an opaque token, never the holder name or the code.
 *  - builds and checks the EIP-4361 message for wallet control.
 */
import 'server-only';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { KrAdapter, type BankAccountVendor, type IdDocumentVendor } from '@pipeline/adapters/kr.js';
import { CodefClient, CodefIdDocumentVendor, CodefBankAccountVendor, type CodefEnv, type CodefLogin } from '@pipeline/adapters/codef.js';
import { OpenBankingAccountVendor, type OpenBankingEnv } from '@pipeline/adapters/openbanking.js';
import { DemoIdDocumentVendor, DemoBankAccountVendor } from '@pipeline/adapters/demo.js';

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
  ({ configured: false, vendor: null, live: false, demo: false, env: e, missing, error });

let codefClient: CodefClient | null = null;
function codef(): CodefClient {
  if (codefClient) return codefClient;
  const missing = CODEF_CLIENT_VARS.filter((v) => !env(v));
  if (missing.length) throw new ConfigError('CODEF client is not configured', missing);
  const e = (env('CODEF_ENV') ?? 'demo') as CodefEnv;
  if (!['sandbox', 'demo', 'api'].includes(e)) throw new ConfigError(`CODEF_ENV must be sandbox, demo or api (got ${e})`, ['CODEF_ENV']);
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
  } catch (err) {
    return { vendor: null, status: unconfigured(e, [], (err as Error).message) };
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
    } catch (err) {
      return demoFallback(['CODEF_ENV=api'], (err as Error).message);
    }
  }
  if (which !== 'openbanking') {
    return { vendor: null, status: unconfigured(null, ['BANK_VENDOR'], `BANK_VENDOR must be openbanking or codef (got ${which})`) };
  }
  const missing = OPENBANKING_VARS.filter((v) => !env(v));
  const e = (env('OPENBANKING_ENV') ?? 'test') as OpenBankingEnv;
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
  } catch (err) {
    return { vendor: null, status: unconfigured(e, [], (err as Error).message) };
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

function sealKey(): Buffer {
  const k = env('EVIDENCE_HMAC_KEY');
  if (!k || k.length < 32) throw new ConfigError('EVIDENCE_HMAC_KEY is required (32+ chars)', ['EVIDENCE_HMAC_KEY']);
  return createHash('sha256').update(`${k}|proofmark-seal-v1`).digest();
}

/** Encrypt-and-authenticate `payload` under a type tag with a lifetime. Opaque to the browser. */
export function seal(typ: string, payload: object, ttlSec: number): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealKey(), iv);
  const pt = Buffer.from(JSON.stringify({ ...payload, typ, exp: Date.now() + ttlSec * 1000 }), 'utf8');
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function open<T extends object>(typ: string, token: unknown): T & { exp: number } {
  if (typeof token !== 'string' || token.length < 40) throw new TokenError(`missing ${typ} token`);
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 29) throw new TokenError(`malformed ${typ} token`);
  const d = createDecipheriv('aes-256-gcm', sealKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  let pt: Buffer;
  try { pt = Buffer.concat([d.update(buf.subarray(28)), d.final()]); } catch { throw new TokenError(`${typ} token failed authentication`); }
  const j = JSON.parse(pt.toString('utf8')) as T & { typ: string; exp: number };
  if (j.typ !== typ) throw new TokenError(`expected a ${typ} token, got ${j.typ}`);
  if (typeof j.exp !== 'number' || j.exp < Date.now()) throw new TokenError(`${typ} token expired; start the step again`);
  return j;
}

/** Keyed digest of the one-won code, so the challenge token can carry it without carrying it. */
export function codeDigest(code: string): string {
  return createHmac('sha256', sealKey()).update(`code|${code.trim()}`).digest('hex');
}
export function codeMatches(code: string, digest: string): boolean {
  const a = Buffer.from(codeDigest(code), 'hex');
  const b = Buffer.from(digest, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── EIP-4361 ──────────────────────────────────────────────────────────────

export interface SiweFields {
  domain: string;
  address: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

export const SIWE_STATEMENT = 'Bind this wallet to a Proofmark compliance mark. Consent v1: the checks below are recorded as bits; no personal data goes on chain.';
export const SIWE_CHAIN_ID = 11155111;

export function siweMessage(f: SiweFields): string {
  return [
    `${f.domain} wants you to sign in with your Ethereum account:`,
    f.address,
    '',
    SIWE_STATEMENT,
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
