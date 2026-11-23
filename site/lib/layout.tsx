import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Logo } from '@site/components/ui/logo';
import { links } from '@site/data/links';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo className="h-[22px]" />,
    },
    githubUrl: links.github,
  };
}
