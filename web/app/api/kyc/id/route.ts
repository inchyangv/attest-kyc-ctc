import { NextResponse } from 'next/server';
import { ConfigError, TokenError, open, requireIdVendor, seal } from '@/lib/kyc-server';
import { VendorError, docHashOf, type IdDocType, type IdDocumentInput, type IdDocumentResult, type TwoWayContinuation } from '@pipeline/adapters/kr.js';

export const runtime = 'nodejs';

const MAX_IMAGE = 5 * 1024 * 1024;

const fail = (e: unknown) => {
  if (e instanceof ConfigError) return NextResponse.json({ error: e.message, missing: e.missing }, { status: 503 });
  if (e instanceof TokenError) return NextResponse.json({ error: e.message }, { status: 400 });
  if (e instanceof VendorError) return NextResponse.json({ error: e.message, code: e.code ?? null, ref: e.ref ?? null }, { status: 422 });
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
};

const text = (form: FormData, k: string) => { const v = form.get(k); return typeof v === 'string' ? v.trim() : ''; };
const digits = (s: string) => s.replace(/\D/g, '');

/**
 * Step 1. multipart/form-data.
 *   action=ocr     read the fields off the image (CODEF OCR)
 *   action=verify  ask the issuing authority (정부24 / 교통민원24) through CODEF. The image is hashed
 *                  into the result; the resident number is used for the query and never stored.
 *                  When the authority wants a captcha, the answer comes back with twoWayToken.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const action = text(form, 'action') || 'verify';
    const docType: IdDocType = text(form, 'docType') === 'DL' ? 'DL' : 'RRC';
    const file = form.get('image');
    if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: 'image is required' }, { status: 400 });
    if (file.size > MAX_IMAGE) return NextResponse.json({ error: 'image must be 5 MB or smaller' }, { status: 413 });
    const image = new Uint8Array(await file.arrayBuffer());

    const adapter = requireIdVendor();

    if (action === 'ocr') {
      const fields = await adapter.readIdDocument(image, docType);
      return NextResponse.json({ fields, docHash: docHashOf(image) });
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
      const t = open<TwoWayContinuation & { docHash: string }>('idTwoWay', twoWayToken);
      if (t.docHash !== docHashOf(image)) return NextResponse.json({ error: 'the document changed between legs; start again' }, { status: 400 });
      input.twoWay = { jobIndex: t.jobIndex, threadIndex: t.threadIndex, jti: t.jti, twoWayTimestamp: t.twoWayTimestamp };
      const secureNo = text(form, 'secureNo');
      const simpleAuth = text(form, 'simpleAuth');
      if (secureNo) input.twoWay.secureNo = secureNo;
      if (simpleAuth === '1' || simpleAuth === '0') input.twoWay.simpleAuth = simpleAuth;
    }

    const out = await adapter.verifyIdDocument(input);

    if (out.kind === 'two_way') {
      const { imageBase64, message, ...rest } = out.challenge;
      return NextResponse.json({
        status: 'two_way',
        challenge: { method: rest.method, message: message ?? null, imageBase64: imageBase64 ?? null },
        // The authority holds the session for about three minutes.
        twoWayToken: seal('idTwoWay', { ...rest, docHash: docHashOf(image) }, 170),
      });
    }

    const { kind: _kind, ...result } = out;
    void _kind;
    const r: IdDocumentResult = result;
    return NextResponse.json({
      status: r.authentic ? 'verified' : 'rejected',
      idProof: seal('id', r as unknown as Record<string, unknown>, 30 * 60),
      summary: {
        docType: r.docType, docHash: r.docHash, authenticityChecked: r.authenticityChecked, authentic: r.authentic,
        live: r.live, vendor: r.vendor, ref: r.ref ?? null, code: r.code ?? null,
      },
    });
  } catch (e) { return fail(e); }
}
