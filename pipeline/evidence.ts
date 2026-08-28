import { ethers } from 'ethers';
import { canonicalJson } from './canonical.js';

/**
 * 증적 해시체인 (append-only).
 *
 *   evidenceHash = H(prevHash ‖ canonicalJson(stepPayload))
 *
 * ★ 감사인·규제기관이 발급사의 오프체인 증적 사본으로 이 체인을 **재계산**해
 *   온체인 `evidenceHash` 와 대조하면 위변조가 없음을 입증할 수 있다 (§3.3).
 *   그래서 각 단계 payload 는 **결정적**이어야 한다 — 랜덤·순회 순서 의존 금지.
 */
export interface EvidenceStep {
  step: string;                       // 'wallet_control' | 'id_doc' | 'bank_account' | 'reconcile' | 'aml'
  at: number;                         // epoch ms — 유일하게 허용되는 시변 값
  payload: Record<string, unknown>;   // PII 원문 금지. 해시·판정·판본만.
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

  /** 증적 사본으로 head 를 재계산한다 — 감사 경로. */
  static recompute(steps: readonly EvidenceStep[]): string {
    let head: string = ethers.ZeroHash;
    for (const s of steps) {
      head = ethers.keccak256(ethers.concat([head, ethers.toUtf8Bytes(canonicalJson(s))]));
    }
    return head;
  }
}
