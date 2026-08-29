import { ethers } from 'ethers';

/**
 * Reconciliation across three axes: declared details, the ID document, and the account holder.
 *
 * All three must agree. Once they do, only the fact that they agreed is kept.
 * The values are discarded.
 * This module never returns cleartext. It returns per-axis agreement and normalised hashes.
 */
export interface ReconcileInput {
  /** What the user declared */
  declared: { fullName: string; dateOfBirth: string };
  /** What the ID document says */
  idDocument: { fullName: string; dateOfBirth: string } | null;
  /** The account holder name */
  bankAccount: { holderName: string } | null;
}

export interface ReconcileResult {
  passed: boolean;
  axes: {
    declaredVsIdDoc: 'match' | 'mismatch' | 'unavailable';
    declaredVsBank:  'match' | 'mismatch' | 'unavailable';
    idDocVsBank:     'match' | 'mismatch' | 'unavailable';
  };
  /** For evidence: hashes of the normalised values, not the values. An auditor can recompute. */
  digests: { declaredName: string; idDocName?: string; bankHolderName?: string; dobMatch: boolean };
}

/** Name normalisation: drop whitespace and punctuation, upper case. Hangul passes through. */
export function normalizeName(s: string): string {
  return s.normalize('NFKC').replace(/[\s.,''`-]/g, '').toUpperCase();
}

function digest(s: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const dn = normalizeName(input.declared.fullName);
  const idn = input.idDocument ? normalizeName(input.idDocument.fullName) : null;
  const bn = input.bankAccount ? normalizeName(input.bankAccount.holderName) : null;

  const cmp = (a: string | null, b: string | null) =>
    a === null || b === null ? 'unavailable' as const : a === b ? 'match' as const : 'mismatch' as const;

  const axes = {
    declaredVsIdDoc: cmp(dn, idn),
    declaredVsBank:  cmp(dn, bn),
    idDocVsBank:     cmp(idn, bn),
  };

  const dobMatch = input.idDocument
    ? input.declared.dateOfBirth === input.idDocument.dateOfBirth
    : false;

  // Fail closed: any mismatch fails. 'unavailable' shows up as an unset method bit for that
  // axis, so this function only has to stop mismatches.
  const passed =
    Object.values(axes).every((a) => a !== 'mismatch') &&
    (input.idDocument ? dobMatch : true);

  return {
    passed,
    axes,
    digests: {
      declaredName: digest(dn),
      idDocName: idn ? digest(idn) : undefined,
      bankHolderName: bn ? digest(bn) : undefined,
      dobMatch,
    },
  };
}
