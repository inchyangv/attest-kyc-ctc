import { ethers } from 'ethers';
import { canonicalJson } from './canonical.js';

/**
 * Evidence hash chain, append only.
 *
 *   evidenceHash = H(prevHash ‖ canonicalJson(stepPayload))
 *
 * An auditor or regulator recomputes this chain from the issuer's offline copy and compares
 * it to the on-chain `evidenceHash` to show nothing was altered.
 * Every step payload must therefore be deterministic. No randomness, no iteration-order
 */
export interface EvidenceStep {
  step: string;                       // 'wallet_control' | 'id_doc' | 'bank_account' | 'reconcile' | 'aml'
  at: number;   // epoch ms, the only time-varying value allowed
  payload: Record<string, unknown>;   // no cleartext PII. Hashes, decisions and versions only.
}

export class EvidenceChain {
  private readonly steps: EvidenceStep[] = [];
  private head: string = ethers.ZeroHash;

  append(step: EvidenceStep): string {
    this.steps.push(step);
    this.head = ethers.keccak256(
      ethers.concat([this.head, ethers.toUtf8Bytes(canonicalJson(step))]),
    );
    return this.head;
  }

  get hash(): string { return this.head; }
  get length(): number { return this.steps.length; }
  export(): EvidenceStep[] { return structuredClone(this.steps); }

  /** Recompute the head from a copy of the evidence. This is the audit path. */
  static recompute(steps: readonly EvidenceStep[]): string {
    let head: string = ethers.ZeroHash;
    for (const s of steps) {
      head = ethers.keccak256(ethers.concat([head, ethers.toUtf8Bytes(canonicalJson(s))]));
    }
    return head;
  }
}
