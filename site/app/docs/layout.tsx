import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { SidebarItem, SidebarSeparator } from '@site/components/docs/sidebar';
import { baseOptions } from '@site/lib/layout';
import { source } from '@site/lib/source';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      sidebar={{
        components: { Item: SidebarItem, Separator: SidebarSeparator },
      }}
      {...baseOptions()}
    >
      {children}
    </DocsLayout>
  );
}
