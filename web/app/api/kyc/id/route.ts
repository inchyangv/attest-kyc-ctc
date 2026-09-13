import { privateJson } from '@/lib/private-response';
import { TokenError, assertSameFlow, flowBinding, flowFromWalletToken, isDemo, open, requireIdVendor, seal, type FlowBinding } from '@/lib/kyc-server';
import { requireSyntheticSampleMode, SyntheticSampleError } from '@pipeline/synthetic-samples.js';
import { publicConfigFailure, publicVendorFailure } from '@/lib/public-errors';
import { guardError, guardRequest } from '@/lib/request-guard';
import { BODY_LIMITS, readBoundedForm } from '@/lib/request-body';
import { ID_IMAGE_POLICY, validateIdImage } from '@/lib/id-image';
import { VendorTransportError } from '@pipeline/adapters/vendor-http.js';
import { docHashOf, type IdDocType, type IdDocumentInput, type IdDocumentResult, type TwoWayContinuation } from '@pipeline/adapters/kr.js';
import { authorizeCurrentProcessing } from '@/lib/privacy-processing-policy-server';
import { authorizeCurrentRetention } from '@/lib/retention-policy-server';

export const runtime = 'nodejs';

const fail = (e: unknown) => {
  if (e instanceof SyntheticSampleError) return privateJson({ error: e.message, code: e.code }, { status: 409 });
  const guarded = guardError(e); if (guarded) return guarded;
  const configured = publicConfigFailure(e); if (configured) return configured;
  if (e instanceof TokenError) return privateJson({ error: e.message }, { status: 400 });
  const vendor = publicVendorFailure(e); if (vendor) return vendor;
  return privateJson({ error: 'internal document verification error' }, { status: 500 });
};

const text = (form: FormData, k: string) => { const v = form.get(k); return typeof v === 'string' ? v.trim() : ''; };
const digits = (s: string) => s.replace(/\D/g, '');

/**
 * Step 1. multipart/form-data.
 *   action=ocr     read the fields off the image (CODEF OCR)
 *   action=verify  ask the issuing authority (Government24 / Traffic Civil Service 24) through CODEF. The image is hashed
 *                  into the result; the resident number is used for the query and never stored.
 *                  When the authority wants a captcha, the answer comes back with twoWayToken.
 */
export async function POST(req: Request) {
  try {
    guardRequest(req, { bucket: 'kyc-id', limit: 20, windowMs: 10 * 60_000, maxBodyBytes: BODY_LIMITS.id, sameOrigin: true });
    const form = await readBoundedForm(req, BODY_LIMITS.id);
    const wallet = flowFromWalletToken(text(form, 'walletProof'));
    const binding = flowBinding(wallet);
    const adapter = requireIdVendor();
    requireSyntheticSampleMode(form.get('syntheticSample'), isDemo(), adapter.idVendor, adapter.bankVendor);
    const action = text(form, 'action') || 'verify';
    if (action !== 'ocr' && action !== 'verify') return privateJson({ error: 'unsupported document action' }, { status: 400 });
    const docType = (text(form, 'docType') || 'RRC') as IdDocType;
    if (docType !== 'DL' && docType !== 'RRC') return privateJson({ error: 'unsupported document type' }, { status: 400 });
    const processingPolicy = authorizeCurrentProcessing(isDemo(), wallet.processingPolicy, {
      stage: 'id_document', recipient: adapter.idVendor!.name,
      data: ['identity_document_image', 'identity_fields', ...(docType === 'RRC' ? ['resident_registration_number' as const] : [])],
    });
    authorizeCurrentRetention(isDemo(), processingPolicy.customerId, wallet.retentionPolicy);
    const file = form.get('image');
    if (!(file instanceof File) || file.size === 0) return privateJson({ error: 'image is required' }, { status: 400 });
    if (file.size > ID_IMAGE_POLICY.maxBytes) return privateJson({ error: 'image must be 5 MiB or smaller' }, { status: 413 });
    const image = new Uint8Array(await file.arrayBuffer());
    await validateIdImage(image, file.type, req.signal);

    if (action === 'ocr') {
      const fields = await adapter.readIdDocument(image, docType);
      return privateJson({ fields, docHash: docHashOf(image) });
    }

    const input: IdDocumentInput = {
      docType,
      image,
      fullName: text(form, 'fullName'),
      birthDate: digits(text(form, 'birthDate')),
      rrn: docType === 'RRC' ? digits(text(form, 'rrn')) : undefined,
      issueDate: docType === 'RRC' ? digits(text(form, 'issueDate')) : undefined,
      licenseNumber: docType === 'DL' ? digits(text(form, 'licenseNumber')) : undefined,
      serialNo: docType === 'DL' ? text(form, 'serialNo').toUpperCase() : undefined,
    };

    const twoWayToken = text(form, 'twoWayToken');
    if (twoWayToken) {
      const t = open<TwoWayContinuation & { docHash: string } & FlowBinding>('idTwoWay', twoWayToken);
      assertSameFlow(wallet, t, 'document continuation');
      if (t.docHash !== docHashOf(image)) return privateJson({ error: 'the document changed between legs; start again' }, { status: 400 });
      input.twoWay = { jobIndex: t.jobIndex, threadIndex: t.threadIndex, jti: t.jti, twoWayTimestamp: t.twoWayTimestamp };
      const secureNo = text(form, 'secureNo');
      const simpleAuth = text(form, 'simpleAuth');
      if (secureNo) input.twoWay.secureNo = secureNo;
      if (simpleAuth === '1' || simpleAuth === '0') input.twoWay.simpleAuth = simpleAuth;
    }

    const out = await adapter.verifyIdDocument(input);

    if (out.kind === 'two_way') {
      const { imageBase64, message, ...rest } = out.challenge;
      void message;
      if (rest.method !== 'secureNo' && rest.method !== 'simpleAuth') throw new VendorTransportError('VENDOR_BAD_RESPONSE');
      return privateJson({
        status: 'two_way',
        challenge: { method: rest.method, message: rest.method === 'secureNo' ? 'Enter the captcha shown by the institution.' : 'Complete the approval in the institution login app.', imageBase64: imageBase64 ?? null },
        // The authority holds the session for about three minutes.
        twoWayToken: seal('idTwoWay', { ...rest, docHash: docHashOf(image), ...binding }, 170),
      });
    }

    const { kind: _kind, ...result } = out;
    void _kind;
    const r: IdDocumentResult = result;
    return privateJson({
      status: r.authentic ? 'verified' : 'rejected',
      idProof: seal('id', { ...r, ...binding } as unknown as Record<string, unknown>, 30 * 60),
      summary: {
        docType: r.docType, docHash: r.docHash, authenticityChecked: r.authenticityChecked, authentic: r.authentic,
        live: r.live, vendor: r.vendor, ref: r.ref ?? null, code: r.code ?? null,
      },
    });
  } catch (e) { return fail(e); }
}
