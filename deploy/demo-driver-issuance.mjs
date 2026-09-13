import { setTimeout as delay } from 'node:timers/promises';
import { driverJsonRequest, DriverHttpError } from './demo-driver-http.mjs';

/** Submit once, then reconcile ONLY the pre-known authenticated flow's request. */
export async function reconcileDriverIssuance(url, requestId, payload, {
  timeoutMs = 300000, pollMs = 5000, onProgress = () => {},
} = {}) {
  if (typeof requestId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(requestId) ||
    !payload || typeof payload.walletProof !== 'string' || !payload.walletProof.length ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000 ||
    !Number.isSafeInteger(pollMs) || pollMs <= 0 || pollMs > 5000 || pollMs > timeoutMs) {
    throw new DriverHttpError('DRIVER_INVALID_ISSUANCE_CONFIG');
  }
  const deadline = performance.now() + timeoutMs;
  let action = 'issue';
  for (let attempt = 0; attempt < 64; attempt++) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) break;
    try {
      const response = await driverJsonRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'issue' ? { ...payload, action: 'issue' }
          : { action, requestId, walletProof: payload.walletProof }),
      }, { timeoutMs: Math.min(30000, remaining) });
      const id = response.body.requestId;
      if ((id !== undefined && (typeof id !== 'string' || id.toLowerCase() !== requestId.toLowerCase())) ||
        (response.status === 200 && id === undefined)) throw new DriverHttpError('DRIVER_REQUEST_ID_MISMATCH');
      if (response.status === 200 && response.body.status === 'PREPARED') action = 'resume';
      else if ([409, 503].includes(response.status) && response.body.resumable === true && id !== undefined) action = 'status';
      else return response; // Includes missing request, auth failure, refusal and confirmed revert: never recreate/retry them.
    } catch (error) {
      if (!(error instanceof DriverHttpError) || !['DRIVER_REQUEST_FAILED', 'DRIVER_REQUEST_TIMEOUT'].includes(error.code)) throw error;
      // Ambiguous transmission/commit: a read-only status query must precede any further resume.
      // Never re-send the identity payload or silently select a new request ID.
      action = 'status';
    }
    const waitRemaining = Math.floor(deadline - performance.now());
    if (waitRemaining <= 0) break;
    onProgress(action); // Only these local fixed action labels, never response diagnostics.
    await delay(Math.min(pollMs, waitRemaining));
  }
  throw new DriverHttpError('DRIVER_ISSUANCE_DEADLINE');
}
