import { ethers } from 'ethers';

/**
 * 에폭 명부 트리 (Mode B).
 *
 * ★ 진짜 난제는 "발급됐다"가 아니라 **"폐기되지 않았다"** 를 증명하는 것이다.
 *   포함 증명은 쉽지만 **비포함 증명은 자료구조가 결정한다.**
 *
 *   평범한 머클트리   → 비포함 증명 불가 (화이트리스트 전용으로만 성립)
 *   Sparse Merkle    → 가능하나 깊이 160~256, 검증 가스 과다
 *   **정렬 키 머클**  → 인접 증명으로 가능, 깊이 ~20(100만건). **채택**
 *
 * 정렬 키 트리에서 비포함은 이렇게 증명한다:
 *   key_i < target < key_{i+1} 인 **연속한 두 리프**를 제시한다.
 *   둘 다 트리에 있고 인덱스가 연속이면, 그 사이에 target 이 없다는 뜻이다.
 *
 * ⚠️ 그래서 OZ 식 정렬쌍 해싱(`hashPair`)을 쓸 수 없다 — 위치 정보가 사라져
 *    "인덱스가 연속" 을 증명할 수 없기 때문이다. **위치 기반 머클**을 쓴다.
 */

export interface RosterEntry {
  subject: string;        // EVM 주소
  attrs: string;          // bytes32 (팩킹 스칼라)
  claimsRoot: string;
  evidenceHash: string;
  issuer: string;
}

export interface RosterTree {
  /** subjectKey 오름차순 정렬된 실제 항목 (센티넬 제외) */
  entries: RosterEntry[];
  /** 센티넬 포함 전체 키. `keys[i+1]` 이 `entries[i]` 에 대응한다 */
  keys: string[];
  /** 센티넬 포함 전체 리프 */
  leaves: string[];
  layers: string[][];           // layers[0] = leaves
  root: string;
}

/** `entries[i]` 의 트리 인덱스. 센티넬 때문에 +1 만큼 밀린다. */
export function leafIndexOf(i: number): number { return i + 1; }

/** 비EVM 확장 여지를 남긴다 (CAIP-10 형태). 지금은 EVM 네임스페이스 고정. */
export const EVM_NAMESPACE = 'eip155';

export function subjectKey(subject: string, namespace: string = EVM_NAMESPACE): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['string', 'address'], [namespace, ethers.getAddress(subject)]),
  );
}

export function markHash(e: RosterEntry): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'address'],
      [e.attrs, e.claimsRoot, e.evidenceHash, ethers.getAddress(e.issuer)],
    ),
  );
}

export function rosterLeaf(e: RosterEntry, namespace: string = EVM_NAMESPACE): string {
  return ethers.keccak256(
    ethers.solidityPacked(['bytes32', 'bytes32'], [subjectKey(e.subject, namespace), markHash(e)]),
  );
}

/** 위치 기반 내부 노드 — 좌우를 정렬하지 않는다. */
function hashNode(left: string, right: string): string {
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [left, right]));
}

/**
 * 경계 센티넬.
 *
 * ★ 왜 필요한가: 센티넬이 없으면 "target 이 마지막 키보다 크다" 를 증명할 때
 *   **그 리프가 정말 마지막인지**를 증명할 수 없다. 공격자가 중간 리프를 제시하면
 *   실제로는 뒤쪽에 target 이 있는데도 비포함이 통과한다.
 *   양 끝에 센티넬을 박으면 **모든 비포함이 인접 두 리프 사이의 간격**이 되어
 *   경계 케이스와 그 구멍이 함께 사라진다.
 */
export const MIN_KEY = '0x' + '00'.repeat(32);
export const MAX_KEY = '0x' + 'ff'.repeat(32);

const SENTINEL_MARK = '0x' + '00'.repeat(32);
const sentinelLeaf = (key: string) =>
  ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [key, SENTINEL_MARK]));

export function buildRoster(entries: readonly RosterEntry[], namespace: string = EVM_NAMESPACE): RosterTree {
  const withKeys = entries.map((e) => ({ e, k: subjectKey(e.subject, namespace) }));
  withKeys.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));

  for (let i = 1; i < withKeys.length; i++) {
    if (withKeys[i].k === withKeys[i - 1].k) {
      throw new Error(`buildRoster: 중복 subject ${withKeys[i].e.subject}`);
    }
  }

  for (const { k, e } of withKeys) {
    if (k === MIN_KEY || k === MAX_KEY) throw new Error(`buildRoster: ${e.subject} 가 센티넬 키와 충돌합니다`);
  }

  // 양 끝 센티넬 — 모든 비포함을 인접 간격 증명으로 통일한다
  const sorted = withKeys.map((x) => x.e);
  const keys = [MIN_KEY, ...withKeys.map((x) => x.k), MAX_KEY];
  const leaves = [
    sentinelLeaf(MIN_KEY),
    ...sorted.map((e) => rosterLeaf(e, namespace)),
    sentinelLeaf(MAX_KEY),
  ];

  const layers: string[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      // 홀수 개면 마지막을 자기 자신과 짝지어 올린다 (위치 유지)
      next.push(hashNode(cur[i], i + 1 < cur.length ? cur[i + 1] : cur[i]));
    }
    layers.push(next);
  }

  return { entries: sorted, keys, leaves, layers, root: layers[layers.length - 1][0] };
}

export interface InclusionProof {
  index: number;
  siblings: string[];
}

export function inclusionProof(tree: RosterTree, index: number): InclusionProof {
  if (index < 0 || index >= tree.leaves.length) throw new Error('inclusionProof: 인덱스 범위 초과');
  const siblings: string[] = [];
  let idx = index;
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l];
    const pair = idx ^ 1;
    siblings.push(pair < layer.length ? layer[pair] : layer[idx]);   // 홀수 꼬리는 자기 자신
    idx >>= 1;
  }
  return { index, siblings };
}

export function verifyInclusion(root: string, leaf: string, proof: InclusionProof): boolean {
  let acc = leaf;
  let idx = proof.index;
  for (const s of proof.siblings) {
    acc = idx % 2 === 0 ? hashNode(acc, s) : hashNode(s, acc);
    idx >>= 1;
  }
  return acc.toLowerCase() === root.toLowerCase();
}

/**
 * 비포함 증명 — 인접한 두 리프 사이의 **간격**으로만 표현한다.
 * 센티넬 덕분에 경계 케이스가 없다.
 */
export interface NonInclusionProof {
  left: InclusionProof;  leftLeaf: string;  leftKey: string;
  right: InclusionProof; rightLeaf: string; rightKey: string;
}

/**
 * target 이 명부에 **없다**는 것을 증명한다.
 * 폐기·미발급을 표현하는 수단이다 — "루트에서 빠지면 끝".
 */
export function nonInclusionProof(tree: RosterTree, target: string, namespace: string = EVM_NAMESPACE): NonInclusionProof {
  const tk = subjectKey(target, namespace);
  if (tree.keys.includes(tk)) throw new Error('nonInclusionProof: 대상이 명부에 있습니다');

  const hi = tree.keys.findIndex((k) => k > tk);
  if (hi <= 0) throw new Error('nonInclusionProof: 센티넬 범위를 벗어났습니다');
  const lo = hi - 1;

  return {
    left:  inclusionProof(tree, lo), leftLeaf:  tree.leaves[lo], leftKey:  tree.keys[lo],
    right: inclusionProof(tree, hi), rightLeaf: tree.leaves[hi], rightKey: tree.keys[hi],
  };
}

export function verifyNonInclusion(
  root: string, target: string, proof: NonInclusionProof, namespace: string = EVM_NAMESPACE,
): boolean {
  const tk = subjectKey(target, namespace);
  // ① target 이 두 키 사이에 있는가
  if (!(proof.leftKey < tk && tk < proof.rightKey)) return false;
  // ② 두 리프가 트리에서 **연속**인가 — 이게 없으면 중간을 건너뛴 위조가 통과한다
  if (proof.right.index !== proof.left.index + 1) return false;
  // ③ 두 리프가 실제로 이 루트에 속하는가
  return verifyInclusion(root, proof.leftLeaf, proof.left)
      && verifyInclusion(root, proof.rightLeaf, proof.right);
}
