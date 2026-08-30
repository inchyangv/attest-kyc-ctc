import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type Tone = 'note' | 'ok' | 'warn' | 'bad';
const TONE: Record<Tone, { box: string; icon: IconName; iconCls: string }> = {
  note: { box: 'border-line bg-surface', icon: 'info', iconCls: 'text-fg-muted' },
  ok: { box: 'border-ok/20 bg-ok-tint', icon: 'check', iconCls: 'text-ok' },
  warn: { box: 'border-warn/20 bg-warn-tint', icon: 'warning', iconCls: 'text-warn' },
  bad: { box: 'border-bad/20 bg-bad-tint', icon: 'x', iconCls: 'text-bad' },
};

/** Message strip. Neutral by default; a tone tints the fill and colours the icon, the text stays readable. */
export function Band({ tone = 'note', icon = true, className = '', children }:
  { tone?: Tone; icon?: boolean; className?: string; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <div className={`flex items-start gap-2.5 rounded-md border px-3.5 py-2.5 text-[13px] leading-5 text-fg ${t.box} ${className}`}>
      {icon && <Icon name={t.icon} size={16} className={`mt-0.5 shrink-0 ${t.iconCls}`} />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
