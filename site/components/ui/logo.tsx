import { cn } from '@site/lib/cn';
import {
  logoMarkTransform,
  logoViewBox,
  markPath,
  markViewBox,
  wordPath,
} from '@site/components/ui/logo-paths';

const markFill = 'fill-stellar-black dark:fill-stellar-yellow';

export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox={logoViewBox}
      role="img"
      aria-label="Stardust"
      className={cn('h-6 w-auto', className)}
    >
      <path className={markFill} transform={logoMarkTransform} d={markPath} />
      <path fill="currentColor" d={wordPath} />
    </svg>
  );
}

export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={markViewBox}
      aria-hidden
      className={cn('size-6', markFill, className)}
    >
      <path d={markPath} />
    </svg>
  );
}
