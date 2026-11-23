'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch';
import { GitHubIcon } from '@site/components/ui/github-icon';
import { Logo } from '@site/components/ui/logo';
import { links } from '@site/data/links';
import { cn } from '@site/lib/cn';

export function Header() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  return (
    <header className="sticky top-0 z-40 mx-auto w-full max-w-6xl px-6 pt-3">
      <div
        className={cn(
          'flex h-14 items-center justify-between rounded-full border ps-5 pe-2 transition-[background-color,border-color,box-shadow] duration-300',
          scrolled
            ? 'border-fd-border bg-fd-background/75 shadow-sm shadow-black/5 backdrop-blur-lg'
            : 'border-transparent bg-transparent',
        )}
      >
        <Link href="/" aria-label="Stardust home">
          <Logo className="h-[20px]" />
        </Link>
        <nav className="flex items-center gap-1">
          <Link
            href={links.docs}
            className="rounded-full px-3 py-2 text-sm font-medium text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          >
            Docs
          </Link>
          <a
            href={links.github}
            aria-label="GitHub"
            className="rounded-full p-2 text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          >
            <GitHubIcon className="size-[18px]" />
          </a>
          <ThemeSwitch className="ms-1" />
        </nav>
      </div>
    </header>
  );
}
