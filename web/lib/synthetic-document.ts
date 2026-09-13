import type { SyntheticScenario } from '@pipeline/synthetic-samples.js';

/** Code-drawn training card, deliberately not a replica of an official identity document. */
export async function syntheticDocument(scenario: SyntheticScenario): Promise<{ file: File; preview: string }> {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 320;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot generate the synthetic training image.');
  ctx.fillStyle = '#10251f'; ctx.fillRect(0, 0, 640, 320);
  ctx.strokeStyle = '#65ddb0'; ctx.lineWidth = 4; ctx.strokeRect(18, 18, 604, 284);
  ctx.fillStyle = '#65ddb0'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('SYNTHETIC SAMPLE — NOT AN ID', 36, 70);
  ctx.fillStyle = '#ffffff'; ctx.font = '20px sans-serif';
  ctx.fillText('Proofmark training fixture', 36, 120);
  ctx.fillText(`Scenario: ${scenario}`, 36, 160);
  ctx.fillText('No portrait. No institution. No real account.', 36, 205);
  ctx.fillText('Never upload your real identity document.', 36, 250);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Synthetic image generation failed.')), 'image/png'));
  return { file: new File([blob], `proofmark-synthetic-${scenario}.png`, { type: 'image/png' }), preview: canvas.toDataURL('image/png') };
}
