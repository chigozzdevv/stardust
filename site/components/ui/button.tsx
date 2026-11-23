import Link from 'next/link';
import type { ComponentProps } from 'react';
import { cn } from '@site/lib/cn';

const variants = {
  primary:
    'bg-stellar-yellow text-stellar-black hover:bg-stellar-yellow/85 shadow-[0_0_0_1px_rgb(15_15_15/0.08)]',
  secondary:
    'border border-fd-border bg-fd-background text-fd-foreground hover:bg-fd-accent',
};

export function ButtonLink({
  variant = 'primary',
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: keyof typeof variants }) {
  return (
    <Link
      className={cn(
        'inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-colors',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
