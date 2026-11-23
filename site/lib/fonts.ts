import localFont from 'next/font/local';

export const inter = localFont({
  src: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  weight: '100 900',
  variable: '--font-inter',
});

export const sora = localFont({
  src: '../node_modules/@fontsource/sora/files/sora-latin-600-normal.woff2',
  weight: '600',
  variable: '--font-sora',
});
