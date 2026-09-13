export type ProviderEnvironment = 'sandbox' | 'production';
export type ProviderObservation = {
  decision: 'not-started' | 'review' | 'approved' | 'rejected';
  environment: ProviderEnvironment;
  observedAt: number;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function parseProviderObservation(value: unknown, subject: string, environment: ProviderEnvironment): ProviderObservation {
  if (!object(value) || value.schema !== 'proofmark-sumsub-evidence-v1' || value.provider !== 'sumsub'
    || value.environment !== environment || typeof value.subject !== 'string' || value.subject.toLowerCase() !== subject.toLowerCase()
    || !['not-started', 'review', 'approved', 'rejected'].includes(String(value.decision))
    || value.methods !== 0 || value.jurisdiction !== null || value.methodMapping !== 'pending-step-evidence'
    || typeof value.observedAt !== 'number' || !Number.isSafeInteger(value.observedAt) || value.observedAt <= 0
    || value.observedAt > 8_640_000_000_000_000) throw new Error('Provider status could not be confirmed.');
  return { decision: value.decision as ProviderObservation['decision'], environment, observedAt: value.observedAt };
}

export const PROVIDER_COPY: Record<ProviderObservation['decision'], { title: string; detail: string }> = {
  'not-started': { title: 'Ready to verify', detail: 'Complete the identity check below to submit your documents for review.' },
  review: { title: 'Your verification is under review', detail: 'Sumsub is reviewing your information. Check back here for the result.' },
  approved: { title: 'Identity review approved', detail: 'Sumsub approved your identity review. Credential issuance is not available yet; no asset eligibility is granted.' },
  rejected: { title: 'Verification needs your attention', detail: 'Sumsub could not approve your identity review. Follow the instructions below to see your next steps.' },
};
