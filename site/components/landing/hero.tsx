import { ArrowRight } from 'lucide-react';
import { GitHubIcon } from '@site/components/ui/github-icon';
import { Example } from '@site/components/landing/example';
import { ButtonLink } from '@site/components/ui/button';
import { CopyCommand } from '@site/components/ui/copy-command';
import { installCommand, links } from '@site/data/links';

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto max-w-6xl px-6 pt-14 pb-20 md:pt-20">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <CopyCommand command={installCommand} />
          <h1 className="mt-6 font-display text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-6xl">
            Automated browser tests for Stellar apps
          </h1>
          <p className="mt-5 max-w-xl text-lg text-pretty text-fd-muted-foreground">
            Drive your app like a real user, with a wallet your test controls.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink href={links.quickstart}>
              Get started
              <ArrowRight className="size-4" />
            </ButtonLink>
            <ButtonLink href={links.github} variant="secondary">
              <GitHubIcon className="size-4" />
              GitHub
            </ButtonLink>
          </div>
        </div>
        <div className="mt-12 md:mt-14">
          <Example />
        </div>
      </div>
    </section>
  );
}
