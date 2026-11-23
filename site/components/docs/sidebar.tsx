'use client';

import { usePathname } from 'fumadocs-core/framework';
import type * as PageTree from 'fumadocs-core/page-tree';
import {
  SidebarItem as BaseItem,
  SidebarSeparator as BaseSeparator,
} from 'fumadocs-ui/components/sidebar/base';

const normalize = (url: string) => url.replace(/\/$/, '') || '/';

export function SidebarSeparator({ item }: { item: PageTree.Separator }) {
  return (
    <BaseSeparator className="mt-6 mb-1.5 px-2 text-[13px] font-semibold text-fd-foreground first:mt-0">
      {item.name}
    </BaseSeparator>
  );
}

export function SidebarItem({ item }: { item: PageTree.Item }) {
  const active = normalize(usePathname()) === normalize(item.url);

  return (
    <BaseItem
      href={item.url}
      external={item.external}
      active={active}
      className="relative ms-1 py-[5px] ps-4 pe-2 text-[13.5px] text-fd-muted-foreground transition-colors before:absolute before:inset-y-1.5 before:start-0 before:w-0.5 before:rounded-full before:bg-transparent hover:text-fd-foreground data-[active=true]:font-medium data-[active=true]:text-fd-foreground data-[active=true]:before:bg-fd-foreground dark:data-[active=true]:before:bg-stellar-yellow"
    >
      {item.name}
    </BaseItem>
  );
}
