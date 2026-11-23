import { cn } from '@site/lib/cn';
import { roadmap } from '@site/data/roadmap';

const columns = [
  { title: 'Available now', tag: '1.0', items: roadmap.now, done: true },
  { title: 'Coming next', tag: 'Planned', items: roadmap.coming, done: false },
];

export function Roadmap() {
  return (
    <section>
      <div className="mx-auto max-w-6xl px-6 py-24">
        <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Roadmap
        </h2>
        <p className="mt-4 text-fd-muted-foreground">
          What works today, and what comes next.
        </p>
        <div className="mt-12 grid gap-12 md:grid-cols-2 md:gap-16">
          {columns.map((column) => (
            <div key={column.title}>
              <div className="flex items-center gap-2.5 border-b border-fd-foreground/15 pb-3">
                <span
                  aria-hidden
                  className={cn(
                    'size-2 rounded-full',
                    column.done
                      ? 'bg-stellar-yellow ring-1 ring-black/15 dark:ring-0'
                      : 'border border-fd-muted-foreground',
                  )}
                />
                <h3 className="text-sm font-medium">{column.title}</h3>
                <span className="ms-auto font-mono text-xs text-fd-muted-foreground">
                  {column.tag}
                </span>
              </div>
              <ul className="divide-y divide-fd-border">
                {column.items.map((item) => (
                  <li
                    key={item.title}
                    className="flex flex-col gap-0.5 py-3.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
                  >
                    <span
                      className={cn(
                        'text-[15px]',
                        !column.done && 'text-fd-foreground/80',
                      )}
                    >
                      {item.title}
                    </span>
                    <span className="text-sm text-fd-muted-foreground sm:text-end">
                      {item.note}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
