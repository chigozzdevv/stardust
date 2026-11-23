import { features } from '@site/data/features';

export function Features() {
  return (
    <section>
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Every wallet flow, under test
          </h2>
        </div>
        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, text }) => (
            <div
              key={title}
              className="rounded-2xl border border-fd-border p-6 transition-colors hover:border-fd-foreground/20"
            >
              <Icon
                className="size-5 text-fd-foreground dark:text-stellar-yellow"
                strokeWidth={1.75}
              />
              <h3 className="mt-4 font-medium">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
                {text}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
