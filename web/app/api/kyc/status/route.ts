import { NextResponse } from 'next/server';
import { getAdapter } from '@/lib/kyc-server';
import { KR_BANKS } from '@pipeline/adapters/kr.js';
import { getEngine } from '@/lib/aml-server';
import { evidenceVaultStatus } from '@/lib/evidence-vault';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Which vendors this deployment has, so the page can say what will and will not run. */
export async function GET() {
  const { status } = getAdapter();
  const { meta } = getEngine();
  return NextResponse.json({
    ...status,
    banks: KR_BANKS,
    vault: evidenceVaultStatus(),
    screening: { builtAt: meta.builtAt, sourceUpdatedAt: meta.sourceUpdatedAt, listVersions: meta.listVersions },
  });
}
