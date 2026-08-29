import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type Tone = 'note' | 'ok' | 'warn' | 'bad' | 'info';
const TONE: Record<Tone, { bg: string; icon: IconName; fg: string }> = {
  note: { bg: 'bg-note-tint', icon: 'info', fg: 'text-fg-strong' },
  info: { bg: 'bg-accent-tint', icon: 'info', fg: 'text-accent-fg' },
  ok: { bg: 'bg-ok-tint', icon: 'check', fg: 'text-ok-fg' },
  warn: { bg: 'bg-warn-tint', icon: 'warning', fg: 'text-warn-fg' },
  bad: { bg: 'bg-bad-tint', icon: 'x', fg: 'text-bad-fg' },
};

/** Full-width message band: the explorer's "scanning new transactions…" strip, with tones. */
export function Band({ tone = 'note', icon = true, className = '', children }:
  { tone?: Tone; icon?: boolean; className?: string; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <div className={`flex items-start gap-2.5 rounded-md px-4 py-2.5 text-sm font-medium ${t.bg} ${t.fg} ${className}`}>
      {icon && <Icon name={t.icon} size={18} className="mt-0.5 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
