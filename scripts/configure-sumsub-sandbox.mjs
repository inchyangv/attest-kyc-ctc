import { createHmac, randomBytes } from 'node:crypto';
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootEnvPath = join(root, '.env');
const webEnvPath = join(root, 'web', '.env.local');

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && (trimmed[0] === '"' || trimmed[0] === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parse(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], unquote(match[2]));
  }
  return values;
}

async function read(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function update(path, values) {
  const original = await read(path);
  const pending = new Map(Object.entries(values));
  const lines = original.split(/\r?\n/).map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]); pending.delete(match[1]);
    return `${match[1]}=${JSON.stringify(value)}`;
  });
  while (lines.length && lines.at(-1) === '') lines.pop();
  if (pending.size) {
    lines.push('', '# Sumsub Sandbox integration test');
    for (const [key, value] of pending) lines.push(`${key}=${JSON.stringify(value)}`);
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${lines.join('\n')}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function first(name, rootValues, webValues) {
  return process.env[name]?.trim() || rootValues.get(name)?.trim() || webValues.get(name)?.trim() || '';
}

async function levels(appToken, secretKey) {
  const method = 'GET';
  const path = '/resources/applicants/-/levels';
  const seconds = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secretKey).update(`${seconds}${method}${path}`).digest('hex');
  const response = await fetch(`https://api.sumsub.com${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(10_000), headers: {
      accept: 'application/json', 'x-app-token': appToken, 'x-app-access-ts': String(seconds), 'x-app-access-sig': signature,
    },
  });
  if (!response.ok) throw new Error(`Sumsub credential check failed with HTTP ${response.status}`);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : Array.isArray(body?.list) ? body.list
    : Array.isArray(body?.list?.items) ? body.list.items : Array.isArray(body?.items) ? body.items : [];
  const names = rows.map((row) => typeof row?.name === 'string' ? row.name : '').filter(Boolean);
  if (!names.length) throw new Error('Sumsub returned no available verification levels');
  return names;
}

const rootText = await read(rootEnvPath);
const webText = await read(webEnvPath);
const rootValues = parse(rootText);
const webValues = parse(webText);
const rawAppToken = first('SUMSUB_SANDBOX_APP_TOKEN', rootValues, webValues);
const rawSecretKey = first('SUMSUB_SANDBOX_SECRET_KEY', rootValues, webValues);
const doubleEquals = rawAppToken.startsWith('=') && rawSecretKey.startsWith('=');
const appToken = doubleEquals ? rawAppToken.slice(1) : rawAppToken;
const secretKey = doubleEquals ? rawSecretKey.slice(1) : rawSecretKey;
if (!appToken || !secretKey) throw new Error('Set SUMSUB_SANDBOX_APP_TOKEN and SUMSUB_SANDBOX_SECRET_KEY in .env first');

const availableLevels = await levels(appToken, secretKey);
const configuredLevel = first('SUMSUB_SANDBOX_LEVEL_NAME', rootValues, webValues);
const levelName = configuredLevel && availableLevels.includes(configuredLevel) ? configuredLevel
  : availableLevels.includes('id-and-liveness') ? 'id-and-liveness'
    : availableLevels.find((name) => /liveness/i.test(name));
if (!levelName) throw new Error(`No document-and-liveness level is available. Available levels: ${availableLevels.join(', ')}`);

const secret = (name) => first(name, rootValues, webValues) || randomBytes(32).toString('hex');
const values = {
  KYC_DEMO: '0',
  SUMSUB_ENVIRONMENT: 'sandbox',
  SUMSUB_SANDBOX_TEST_MODE: '1',
  SUMSUB_SANDBOX_APP_TOKEN: appToken,
  SUMSUB_SANDBOX_SECRET_KEY: secretKey,
  SUMSUB_SANDBOX_WEBHOOK_SECRET: secret('SUMSUB_SANDBOX_WEBHOOK_SECRET'),
  SUMSUB_SANDBOX_LEVEL_NAME: levelName,
  SUMSUB_PROCESSING_RECIPIENT: 'sumsub:sandbox',
  SUMSUB_EVIDENCE_HMAC_KEY: secret('SUMSUB_EVIDENCE_HMAC_KEY'),
  SUMSUB_STATE_KEY: secret('SUMSUB_STATE_KEY'),
  SUMSUB_STATE_TTL_SECONDS: '86400',
  SUMSUB_STATE_NAMESPACE: 'proofmark-sandbox',
  SUMSUB_STATE_MODE: 'memory',
  SUMSUB_LOCAL_TEST: '1',
  SUMSUB_SDK_TTL_SECONDS: '600',
  SUMSUB_WEBHOOK_MAX_AGE_SECONDS: '600',
  SERVER_TOKEN_KEY: secret('SERVER_TOKEN_KEY'),
  SERVER_TOKEN_KEY_ID: first('SERVER_TOKEN_KEY_ID', rootValues, webValues) || 'sumsub-sandbox-k1',
};

const secrets = [values.SUMSUB_SANDBOX_APP_TOKEN, values.SUMSUB_SANDBOX_SECRET_KEY, values.SUMSUB_SANDBOX_WEBHOOK_SECRET,
  values.SUMSUB_EVIDENCE_HMAC_KEY, values.SUMSUB_STATE_KEY, values.SERVER_TOKEN_KEY];
if (new Set(secrets).size !== secrets.length) throw new Error('Sumsub and custody secrets must all be distinct');

await update(rootEnvPath, values);
await update(webEnvPath, values);
const rootMode = (await stat(rootEnvPath)).mode & 0o777;
const webMode = (await stat(webEnvPath)).mode & 0o777;
console.log(JSON.stringify({ configured: true, environment: 'sandbox', testOnly: true, levelName,
  credentialsValidated: true, state: 'local-memory', rootEnvMode: rootMode.toString(8), webEnvMode: webMode.toString(8) }));
