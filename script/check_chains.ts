/**
 * 지원 체인 조회 — preflight 에서 `configureSource(chainKey, …)` 의 chainKey 가 맞는지 확인한다.
 *
 * chainKey 는 chainId 와 다르다(Sepolia: chainKey 1, chainId 11155111).
 * 하드코딩하지 않고 런타임에 확인하는 것이 원칙이므로(docs/01-env-verification.md §3.3),
 * 배포 직전에 실제 체인에 물어본다.
 *
 * 사용: npx tsx script/check_chains.ts <expectedChainKey> <expectedChainId>
 * 종료코드 0 = 일치, 1 = 불일치/조회실패
 */
import { ethers } from 'ethers';
import { chainInfo } from '@gluwa/usc-sdk';

async function main() {
  const [wantKeyArg, wantIdArg] = process.argv.slice(2);
  const wantKey = Number(wantKeyArg);
  const wantId = Number(wantIdArg);
  const rpc = process.env.CREDITCOIN_RPC_URL;

  if (!rpc) throw new Error('CREDITCOIN_RPC_URL 미설정');
  if (!Number.isFinite(wantKey) || !Number.isFinite(wantId)) {
    throw new Error('사용법: check_chains.ts <expectedChainKey> <expectedChainId>');
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  // SDK 가 자체 ethers 사본을 번들해 타입 식별자가 갈린다. 런타임 객체는 동일하다.
  const info = new chainInfo.PrecompileChainInfoProvider(provider as any);
  const chains = await info.getSupportedChains();

  console.log('  지원 체인:');
  for (const c of chains) {
    const name = c.chainName?.startsWith?.('0x')
      ? Buffer.from(c.chainName.slice(2), 'hex').toString('utf8')
      : String(c.chainName ?? '');
    console.log(`    chainKey ${c.chainKey} → chainId ${c.chainId}  (${name})`);
  }

  const hit = chains.find((c: any) => Number(c.chainKey) === wantKey);
  if (!hit) {
    console.error(`  ✗ chainKey ${wantKey} 가 지원 목록에 없습니다`);
    process.exit(1);
  }
  if (Number(hit.chainId) !== wantId) {
    console.error(`  ✗ chainKey ${wantKey} 의 chainId 가 ${hit.chainId} 입니다 (기대 ${wantId})`);
    process.exit(1);
  }

  // 어테스트가 실제로 진행 중인지도 함께 본다 — 멈춰 있으면 배포해도 E2E 가 안 돈다
  const attested = await info.getLatestAttestedHeightAndHash(wantKey);
  console.log(`  ✓ chainKey ${wantKey} = chainId ${wantId} 확인 · 최신 어테스트 높이 ${attested.height}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('  ✗ 지원 체인 조회 실패:', e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
