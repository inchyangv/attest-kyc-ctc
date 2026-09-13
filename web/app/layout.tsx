import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Shell } from '@/components/shell/Shell';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Proofmark · Verify once. Keep moving.', template: '%s · Proofmark' },
  description: 'Verify your identity, check a wallet, and review digital asset eligibility with Proofmark.',
};

export const viewport: Viewport = { themeColor: '#10285a', colorScheme: 'light' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-canvas text-fg antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
