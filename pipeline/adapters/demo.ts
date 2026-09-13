import { createHash } from 'node:crypto';
import {
  docHashOf, isoDate, validateIdInput, VendorError,
  type BankAccountVendor, type IdDocType, type IdDocumentInput, type IdDocumentOutcome, type IdDocumentVendor, type OcrFields,
} from './kr.js';

/**
 * Demo vendors, for an axis that has no real vendor behind it yet.
 *
 * They speak the same interface as CODEF and Open Banking and take the same inputs, so the flow,
 * the tokens, the reconciliation and the evidence are exercised for real. What they do not do is
 * ask anyone: `live` is false, the vendor name starts with `demo:`, and every reference starts
 * with `demo-`. The adapter sets a bit from them only under `sandboxBits`, and the mark then
 * carries regime KR_FSC_NONFACE_SANDBOX. Nothing here can be mistaken for a real check by anyone
 * who reads the evidence or the mark.
 *
 * Rules, so a demo can show both outcomes:
 *   - a name containing the Korean word for "forged" or "FAKE", or a document number of one repeated digit, is not authentic
 *   - an account number ending in "99" belongs to someone else (holder mismatch)
 *   - the one-won code is derived from the account number, so it is stable across a demo run
 */
const ref = (...parts: string[]) => `demo-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 10)}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DemoIdDocumentVendor implements IdDocumentVendor {
  readonly name = 'demo:id';
  readonly live = false;
  readonly biometricChecks = [] as const;

  constructor(private readonly latencyMs = 400) {}

  /** No OCR engine here. The customer types the fields; the UI says so. */
  async ocr(_image: Uint8Array, docType: IdDocType): Promise<OcrFields> {
    void _image;
    await pause(this.latencyMs / 2);
    return { docType };
  }

  async verify(input: IdDocumentInput): Promise<IdDocumentOutcome> {
    validateIdInput(input);
    await pause(this.latencyMs);
    const docHash = docHashOf(input.image);
    const name = input.fullName.trim();
    const number = input.docType === 'RRC' ? input.rrn! : input.licenseNumber!;
    const forged = /\uC704\uC870|FAKE/i.test(name) || /^(\d)\1+$/.test(number);
    return {
      kind: 'verified',
      docType: input.docType,
      fullName: name,
      dateOfBirth: isoDate(input.birthDate),
      docHash,
      authenticityChecked: true,
      authentic: !forged,
      faceMatched: false,
      livenessPassed: false,
      vendor: this.name,
      live: false,
      ref: ref('id', docHash),
      code: forged ? '0' : '1',
    };
  }
}

export class DemoBankAccountVendor implements BankAccountVendor {
  readonly name = 'demo:bank';
  readonly live = false;

  constructor(private readonly latencyMs = 400) {}

  async holderName(input: { bankCode: string; accountNumber: string; birthDate: string; declaredName?: string }) {
    await pause(this.latencyMs);
    if (!input.declaredName) throw new VendorError('the demo bank needs the declared name to echo', 'DEMO_NO_NAME');
    const holder = input.accountNumber.endsWith('99') ? 'Different Person' : input.declaredName.trim();
    return { holderName: holder, ref: ref('holder', input.bankCode, input.accountNumber) };
  }

  /** The code is a function of the account, so the demo can show it and it stays the same on retry. */
  static codeFor(bankCode: string, accountNumber: string): string {
    const h = createHash('sha256').update(`demo-one-won|${bankCode}|${accountNumber}`).digest();
    return String(1000 + (h.readUInt16BE(0) % 9000));
  }

  async oneWonTransfer(input: { bankCode: string; accountNumber: string; holderName: string }) {
    await pause(this.latencyMs);
    return { authCode: DemoBankAccountVendor.codeFor(input.bankCode, input.accountNumber), ref: ref('won', input.bankCode, input.accountNumber, input.holderName) };
  }
}
