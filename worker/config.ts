import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 이 없습니다 (.env 확인)`);
  return v;
}
function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (!v) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`환경변수 ${name} 이 숫자가 아닙니다: ${v}`);
  return n;
}

export const cfg = {
  sourceRpc:     req('SOURCE_CHAIN_RPC_URL'),
  hubRpc:        req('CREDITCOIN_RPC_URL'),
  proofBuilder:  req('PROOF_BUILDER_URL').replace(/\/+$/, ''),
  privateKey:    req('DEPLOYER_PRIVATE_KEY'),
  sourceAddress: req('SOURCE_CONTRACT_ADDRESS'),
  ascAddress:    req('ASC_CONTRACT_ADDRESS'),
  chainKey:      num('SOURCE_CHAIN_KEY', 1),

  /// 소스 체인 스캔 시 헤드에서 몇 블록 뒤까지만 확정으로 볼 것인가.
  /// 리오그로 사라질 tx 를 작업으로 만들지 않기 위한 지연.
  confirmations: num('WORKER_CONFIRMATIONS', 4),
  /// 한 번에 스캔할 블록 범위 상한 (공용 RPC 의 eth_getLogs 제한 회피)
  scanChunk:     num('WORKER_SCAN_CHUNK', 500),
  /// 폴링 간격
  pollMs:        num('WORKER_POLL_MS', 12_000),
  /// 동시에 처리할 작업 수 — 어테스트 8분 대기가 서로를 막지 않게 한다
  concurrency:   num('WORKER_CONCURRENCY', 8),
  /// 영구 실패로 판정하기까지의 시도 횟수
  maxAttempts:   num('WORKER_MAX_ATTEMPTS', 8),
  statePath:     process.env.WORKER_STATE_PATH ?? 'state/worker.json',
  /// 처음 시작할 때 어느 블록부터 볼 것인가 (0 = 현재 헤드)
  startBlock:    num('WORKER_START_BLOCK', 0),
};
