'use client';

import { useEffect, useRef, useState } from 'react';
import { isTrainingResult, type SanctionsTrainingResult, type TrainingScenario } from '@pipeline/sanctions-training-model.js';
import { Button } from './ui/Button';
import { Band } from './ui/Band';

export function SanctionsTraining() {
  const [result, setResult] = useState<SanctionsTrainingResult | null>(null);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  async function run(scenario: TrainingScenario) {
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller;
    setResult(null); setFailed(false); setBusy(true);
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/demo/screen', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario }), signal: controller.signal, cache: 'no-store' });
      const body: unknown = await response.json();
      if (!response.ok || !isTrainingResult(body, scenario)) throw new Error('training unavailable');
      if (!controller.signal.aborted) setResult(body);
    } catch { if (pending.current === controller) setFailed(true); }
    finally { clearTimeout(timer); if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  return <details aria-label="Sample sanctions screening" className="panel mb-5 overflow-hidden">
    <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-fg-muted">Try a sample screening</summary>
    <div className="border-t border-line p-5">
    <p className="text-[13px] text-fg-muted">Demo only. These sample identities do not create a credential or grant access.</p>
    <div className="mt-4 flex flex-wrap gap-2">
      {([['full-match', 'Full identity match'], ['name-only', 'Name only'], ['dob-conflict', 'Different birth date'], ['no-match', 'No match']] as const).map(([scenario, label]) =>
        <Button key={scenario} variant="secondary" disabled={busy} onClick={() => run(scenario)}>{label}</Button>)}
    </div>
    <div aria-live="polite" aria-busy={busy} className="mt-4">
      {busy && <p className="text-[13px]">Checking the sample…</p>}
      {failed && <p role="alert" className="text-[13px] text-bad">The sample could not be checked. Please try again.</p>}
      {result && <div data-training-result={result.trainingDecision}>
        <Band tone={result.trainingDecision === 'BLOCK' ? 'bad' : result.trainingDecision === 'REVIEW' ? 'warn' : 'ok'}><strong>{result.trainingDecision === 'BLOCK' ? 'Blocked' : result.trainingDecision === 'REVIEW' ? 'Review required' : 'No match found'}</strong></Band>
        <dl className="mt-4 grid gap-2 text-[13px] text-fg-muted">
          <div><dt className="inline font-medium text-fg-strong">Sample identity: </dt><dd className="inline">{result.subject.name} · {result.subject.dateOfBirth || 'Birth date not supplied'} · {result.subject.nationality || 'Nationality not supplied'}</dd></div>
          <div><dt className="inline font-medium text-fg-strong">Compared with: </dt><dd className="inline">{result.fixture.name} · {result.fixture.datesOfBirth.join(', ')} · {result.fixture.nationalities.join(', ')}</dd></div>
        </dl>
        <details className="mt-4 border-t border-divider pt-3">
          <summary className="cursor-pointer text-xs text-fg-muted">Comparison details</summary>
          <dl className="mt-3 grid gap-2 text-xs text-fg-muted">
          {result.comparisons.map((c, i) => <div key={i}><dt className="inline font-medium">Comparison: </dt><dd className="inline">name score {c.score.toFixed(2)} · DOB {c.dateOfBirth} · nationality {c.nationality}</dd></div>)}
          <div><dt className="inline font-medium">Engine: </dt><dd className="inline">{result.engineVersion}</dd></div>
          <div className="break-all"><dt className="inline font-medium">Sample reference: </dt><dd className="inline mono">{result.dataset.sha256}</dd></div>
          </dl>
        </details>
      </div>}
    </div>
    </div>
  </details>;
}
