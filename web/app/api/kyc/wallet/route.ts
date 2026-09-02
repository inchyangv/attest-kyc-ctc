import { NextResponse } from 'next/server';
import { getAddress, isAddress, verifyMessage, type Hex } from 'viem';
import { CONSENT_VERSION, ConfigError, TokenError, newNonce, open, seal, siweMessage, type SiweFields } from '@/lib/kyc-server';
import { guardError, guardRequest } from '@/lib/request-guard';

export const runtime = 'nodejs';

const fail = (e: unknown) => {
  const guarded = guardError(e); if (guarded) return guarded;
  if (e instanceof ConfigError) return NextResponse.json({ error: e.message, missing: e.missing }, { status: 503 });
  if (e instanceof TokenError) return NextResponse.json({ error: e.message }, { status: 400 });
  return NextResponse.json({ error: 'internal wallet verification error' }, { status: 500 });
};

/** Step 0a. The message to sign. Its fields ride along sealed, so verification is stateless. */
export async function GET(req: Request) {
  try {
    guardRequest(req, { bucket: 'wallet-message', limit: 30, windowMs: 10 * 60_000 });
    const url = new URL(req.url);
    const raw = url.searchParams.get('address') ?? '';
    if (!isAddress(raw)) return NextResponse.json({ error: 'address is not an Ethereum address' }, { status: 400 });
    const address = getAddress(raw);
    const host = url.host;
    const now = new Date();
    const fields: SiweFields = {
      domain: host,
      address,
      uri: `${url.origin}/verify`,
      nonce: newNonce(),
      issuedAt: now.toISOString(),
      expirationTime: new Date(now.getTime() + 10 * 60_000).toISOString(),
    };
    return NextResponse.json({ message: siweMessage(fields), token: seal('siwe', fields, 600) });
  } catch (e) { return fail(e); }
}

/** Step 0b. Check the signature over exactly the message we issued. */
export async function POST(req: Request) {
  try {
    guardRequest(req, { bucket: 'wallet-signature', limit: 30, windowMs: 10 * 60_000, maxBodyBytes: 16_384, sameOrigin: true });
    const { token, signature } = await req.json().catch(() => ({})) as { token?: string; signature?: string };
    const f = open<SiweFields>('siwe', token);
    const url = new URL(req.url);
    if (f.domain !== url.host || new URL(f.uri).origin !== url.origin) throw new TokenError('wallet message origin mismatch');
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return NextResponse.json({ error: 'signature must be a 65-byte hex string' }, { status: 400 });
    }
    const message = siweMessage(f);
    // A malformed signature (bad recovery byte) makes viem throw; that is the same answer as "no".
    const ok = await verifyMessage({ address: f.address as `0x${string}`, message, signature: signature as Hex }).catch(() => false);
    if (!ok) return NextResponse.json({ error: 'the signature does not match the wallet' }, { status: 422 });
    return NextResponse.json({
      address: f.address,
      walletProof: seal('wallet', { address: f.address, flowId: f.nonce, consentVersion: CONSENT_VERSION, at: Date.now() }, 30 * 60),
    });
  } catch (e) { return fail(e); }
}
