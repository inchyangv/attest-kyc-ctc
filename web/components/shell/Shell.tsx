import type { ReactNode } from 'react';
import { TopBar } from './TopBar';
import { Sidebar, MobileNav } from './Sidebar';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar />
      <MobileNav />
      <div className="flex flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 px-4 pb-16 pt-6 sm:px-6 lg:px-12">
          <div className="mx-auto max-w-[1160px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
