import type { ReactNode } from 'react';
import { Sidebar, MobileNav } from './Sidebar';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <MobileNav />
      <div className="flex flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 px-4 pb-20 pt-6 sm:px-6 lg:px-10 lg:pt-8">
          <div className="mx-auto max-w-[1120px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
