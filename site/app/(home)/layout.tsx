import { Header } from '@site/components/landing/header';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <div className="relative isolate flex flex-1 flex-col">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[700px] bg-[radial-gradient(60%_50%_at_50%_0%,rgb(253_218_36/0.10),transparent)] dark:bg-[radial-gradient(60%_50%_at_50%_0%,rgb(253_218_36/0.07),transparent)]"
      />
      <Header />
      {children}
    </div>
  );
}
