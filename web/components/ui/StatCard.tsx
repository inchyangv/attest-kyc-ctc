import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/** Explorer stat tile: gray.50 fill, 12px radius, icon + 12px label + 18px value. */
export function StatCard({ icon, label, value, sub, className = '' }:
  { icon?: IconName; label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 items-center gap-3 rounded-lg bg-surface px-3 py-3 ${className}`}>
      {icon && <Icon name={icon} className="shrink-0 text-fg-strong" />}
      <div className="min-w-0">
        <div className="truncate text-xs text-fg-muted">{label}</div>
        {/* One text line: the unit/sub is last, so it truncates before the value does. */}
        <div className="truncate text-lg font-medium leading-6 text-fg-strong">
          {value}
          {sub && <span className="ml-1.5 text-sm font-normal text-fg-muted">{sub}</span>}
        </div>
      </div>
    </div>
  );
}
