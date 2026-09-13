import { privateJson } from '@/lib/private-response';
import { issuanceRequestId } from '@/lib/issuance-request';
import { getAddress, isAddress, verifyMessage, type Hex } from 'viem';
import { TokenError, isDemo, newNonce, open, seal, siweMessage, flowFromWalletToken, type SiweFields } from '@/lib/kyc-server';
import { publicConfigFailure } from '@/lib/public-errors';
import { guardError, guardRequest } from '@/lib/request-guard';
import { BODY_LIMITS, readJsonObject } from '@/lib/request-body';
import { authorizeCurrentProcessing, processingPolicyContext } from '@/lib/privacy-processing-policy-server';
import { authorizeCurrentRetention, retentionPolicyContext } from '@/lib/retention-policy-server';
import { consentTextHash } from '@pipeline/privacy-processing-policy';

export const runtime = 'nodejs';

const fail = (e: unknown) => {
  const guarded = guardError(e); if (guarded) return guarded;
  const configured = publicConfigFailure(e); if (configured) return configured;
  if (e instanceof TokenError) return privateJson({ error: e.message }, { status: 400 });
  return privateJson({ error: 'internal wallet verification error' }, { status: 500 });
};

/** Step 0a. The message to sign. Its fields ride along sealed, so verification is stateless. */
export async function GET(req: Request) {
  try {
    guardRequest(req, { bucket: 'wallet-message', limit: 30, windowMs: 10 * 60_000 });
    const url = new URL(req.url);
    const raw = url.searchParams.get('address') ?? '';
    if (!isAddress(raw)) return privateJson({ error: 'address is not an Ethereum address' }, { status: 400 });
    const address = getAddress(raw);
    const processing = processingPolicyContext(isDemo());
    const retention = retentionPolicyContext(isDemo(), processing.policy.customerId);
    authorizeCurrentProcessing(isDemo(), processing.binding, {
      stage: 'wallet_consent', recipient: 'proofmark:web', data: ['wallet_address', 'consent_record'],
    });
    const host = url.host;
    const now = new Date();
    const fields: SiweFields = {
      domain: host,
      address,
      uri: `${url.origin}/verify`,
      nonce: newNonce(),
      issuedAt: now.toISOString(),
      expirationTime: new Date(now.getTime() + 10 * 60_000).toISOString(),
      processingPolicy: processing.binding,
      retentionPolicy: retention.binding,
      statement: `${processing.consentStatement} ${retention.consentStatement}`,
    };
    return privateJson({ message: siweMessage(fields), token: seal('siwe', fields, 600),
      processingPolicy: processing.binding, retentionPolicy: retention.binding });
  } catch (e) { return fail(e); }
}

/** Step 0b. Check the signature over exactly the message we issued. */
export async function POST(req: Request) {
  try {
    guardRequest(req, { bucket: 'wallet-signature', limit: 30, windowMs: 10 * 60_000, maxBodyBytes: BODY_LIMITS.wallet, sameOrigin: true });
    const { token, signature } = await readJsonObject(req, BODY_LIMITS.wallet);
    const f = open<SiweFields>('siwe', token);
    const url = new URL(req.url);
    if (f.domain !== url.host || new URL(f.uri).origin !== url.origin) throw new TokenError('wallet message origin mismatch');
    if (!f.processingPolicy || !f.retentionPolicy || !f.statement) throw new TokenError('wallet message has no processing or retention policy binding');
    const processing = processingPolicyContext(isDemo());
    authorizeCurrentProcessing(isDemo(), f.processingPolicy, {
      stage: 'wallet_consent', recipient: 'proofmark:web', data: ['wallet_address', 'consent_record'],
    });
    const retention = retentionPolicyContext(isDemo(), processing.policy.customerId);
    authorizeCurrentRetention(isDemo(), processing.policy.customerId, f.retentionPolicy);
    if (f.statement !== `${processing.consentStatement} ${retention.consentStatement}`) throw new TokenError('processing or retention notice changed; start a new flow');
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return privateJson({ error: 'signature must be a 65-byte hex string' }, { status: 400 });
    }
    const message = siweMessage(f);
    // A malformed signature (bad recovery byte) makes viem throw; that is the same answer as "no".
    const ok = await verifyMessage({ address: f.address as `0x${string}`, message, signature: signature as Hex }).catch(() => false);
    if (!ok) return privateJson({ error: 'the signature does not match the wallet' }, { status: 422 });
    const walletProof = seal('wallet', { address: f.address, flowId: f.nonce,
      consentVersion: processing.policy.notice.version, processingPolicy: processing.binding,
      retentionPolicy: retention.binding, consentStatementHash: consentTextHash(f.statement), at: Date.now() }, 30 * 60);
    const walletExpiresAt = flowFromWalletToken(walletProof).exp;
    return privateJson({
      address: f.address,
      requestId: issuanceRequestId(f.address, f.nonce),
      walletProof, walletExpiresAt, serverTime: Date.now(), processingPolicy: processing.binding,
      retentionPolicy: retention.binding,
    });
  } catch (e) { return fail(e); }
}
