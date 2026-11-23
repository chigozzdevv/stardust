import type { Metadata } from 'next';
import { Provider } from '@site/components/provider';
import { cn } from '@site/lib/cn';
import { inter, sora } from '@site/lib/fonts';
import '@site/styles/global.css';

export const metadata: Metadata = {
  title: { default: 'Stardust', template: '%s · Stardust' },
  description:
    'Automated browser tests for Stellar apps, with a wallet your test controls.',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
  manifest: '/manifest.webmanifest',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={cn(inter.variable, sora.variable, 'font-sans')}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
