import { runSanctionsTraining } from '@pipeline/sanctions-training.js';
import { isTrainingScenario } from '@pipeline/sanctions-training-model.js';
import { privateJson } from '@/lib/private-response';
import { guardError, guardRequest } from '@/lib/request-guard';
import { readJsonObject } from '@/lib/request-body';

export const runtime = 'nodejs';

/** Separate fixed-input education route. Never substitute this for /api/screen or issuance. */
export async function POST(req: Request) {
  try {
    guardRequest(req, { bucket: 'synthetic-screen', limit: 20, windowMs: 60_000, maxBodyBytes: 1024, sameOrigin: true });
    // Education can coexist with hosted verification without enabling synthetic issuance.
    if (process.env.KYC_DEMO !== '1' && process.env.SANCTIONS_TRAINING_ENABLED !== '1') {
      return privateJson({ error: 'Synthetic training is disabled.' }, { status: 404 });
    }
    const body = await readJsonObject(req, 1024);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'scenario') || !isTrainingScenario(body.scenario)) {
      return privateJson({ error: 'Select a fixed training scenario only. Personal fields, wallet addresses and proofs are not accepted.' }, { status: 400 });
    }
    return privateJson(await runSanctionsTraining(body.scenario));
  } catch (e) {
    const guarded = guardError(e); if (guarded) return guarded;
    return privateJson({ error: 'Synthetic training is unavailable. No screening result was produced.' }, { status: 503 });
  }
}
