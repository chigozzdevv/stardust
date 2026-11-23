import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { findNeighbour } from 'fumadocs-core/page-tree';
import type * as PageTree from 'fumadocs-core/page-tree';
import { cn } from '@site/lib/cn';

export function PageNav({ tree, url }: { tree: PageTree.Root; url: string }) {
  const { previous, next } = findNeighbour(tree, url);
  if (!previous && !next) return null;

  return (
    <nav className="mt-4 grid gap-3 border-t border-fd-border pt-8 sm:grid-cols-2">
      {previous && <NavLink item={previous} direction="previous" />}
      {next && <NavLink item={next} direction="next" />}
    </nav>
  );
}

function NavLink({
  item,
  direction,
}: {
  item: PageTree.Item;
  direction: 'previous' | 'next';
}) {
  const isNext = direction === 'next';
  const Arrow = isNext ? ArrowRight : ArrowLeft;

  return (
    <Link
      href={item.url}
      className={cn(
        'group flex flex-col gap-1 rounded-xl border border-fd-border px-4 py-3 transition-colors hover:border-fd-foreground/25 hover:bg-fd-accent/40',
        isNext && 'items-end text-end sm:col-start-2',
      )}
    >
      <span className="text-xs text-fd-muted-foreground">
        {isNext ? 'Next' : 'Previous'}
      </span>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-sm font-medium text-fd-foreground',
          isNext && 'flex-row-reverse',
        )}
      >
        <Arrow
          className={cn(
            'size-3.5 text-fd-muted-foreground transition-transform group-hover:text-fd-foreground',
            isNext
              ? 'group-hover:translate-x-0.5'
              : 'group-hover:-translate-x-0.5',
          )}
        />
        {item.name}
      </span>
    </Link>
  );
}
