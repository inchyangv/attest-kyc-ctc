import { CreditcoinMark, Icon } from '@/components/ui/Icon';
import { CC3_EXPLORER, SEPOLIA_EXPLORER } from '@/lib/links';
import { ThemeToggle } from './ThemeToggle';

/** 36px utility bar, as on the explorer: network context on the left, settings on the right. */
export function TopBar() {
  return (
    <div className="flex h-9 items-center gap-3 border-b border-divider bg-canvas px-4 text-xs font-medium lg:px-6">
      <a href={CC3_EXPLORER} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1.5">
        <CreditcoinMark size={14} className="text-fg-strong" />
        <span>Creditcoin CC3 Testnet</span>
        <span className="hidden text-fg-subtle sm:inline">· 102031</span>
      </a>
      <span className="h-4 w-px bg-line" />
      <a href={SEPOLIA_EXPLORER} target="_blank" rel="noreferrer" className="hidden items-center gap-1 text-fg-muted hover:text-link sm:inline-flex">
        <span>Source chain</span><span className="text-fg-strong">Sepolia</span>
        <span className="text-fg-subtle">· chainKey 1</span>
      </a>
      <span className="ml-auto hidden items-center gap-1.5 text-fg-muted sm:inline-flex">
        <Icon name="bolt" size={14} className="text-ok" />Attestcoin proofs · BlockProver 0x…0FD2
      </span>
      <span className="ml-auto sm:ml-0"><ThemeToggle /></span>
    </div>
  );
}
