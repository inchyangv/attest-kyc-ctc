import { CreditcoinMark } from '@/components/ui/Icon';
import { CC3_EXPLORER, SEPOLIA_EXPLORER } from '@/lib/links';

/** 40px utility bar: network context on the left, prover on the right. Everything is 12px on one baseline. */
export function TopBar() {
  return (
    <div className="flex h-10 shrink-0 items-center gap-4 border-b border-line px-4 text-xs leading-4 lg:px-5">
      <a href={CC3_EXPLORER} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-fg-strong hover:text-mint">
        <CreditcoinMark size={14} />
        <span className="font-medium">Creditcoin CC3 Testnet</span>
        <span className="mono hidden text-fg-muted sm:inline">102031</span>
      </a>
      <span className="h-4 w-px bg-line" aria-hidden />
      <a href={SEPOLIA_EXPLORER} target="_blank" rel="noreferrer" className="hidden items-center gap-2 text-fg-muted hover:text-fg-strong sm:inline-flex">
        <span>Source</span><span className="font-medium text-fg-strong">Ethereum Sepolia</span>
        <span className="mono">chainKey 1</span>
      </a>
      <span className="ml-auto hidden items-center gap-2 text-fg-muted sm:inline-flex">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
        Attestcoin proofs
        <span className="mono text-fg-strong">BlockProver 0x…0FD2</span>
      </span>
    </div>
  );
}
