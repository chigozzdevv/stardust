import Link from 'next/link';
import { Logo } from '@site/components/ui/logo';
import { links } from '@site/data/links';

const items = [
  { text: 'Docs', href: links.docs },
  { text: 'GitHub', href: links.github },
];

export function Footer() {
  return (
    <footer className="mt-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <Logo className="h-5" />
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-fd-muted-foreground">
          {items.map((item) => (
            <Link
              key={item.text}
              href={item.href}
              className="transition-colors hover:text-fd-foreground"
            >
              {item.text}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
