import { FileCode2, SquareTerminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ServerCodeBlock } from 'fumadocs-ui/components/codeblock.rsc';
import { exampleFile, exampleRun, exampleTest } from '@site/data/example';

const muted = 'text-fd-muted-foreground';
const red = 'text-red-500 dark:text-red-400';
const green = 'text-emerald-600 dark:text-emerald-500';

function PaneTitle({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: string;
}) {
  return (
    <div
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-fd-border px-4 font-mono text-xs ${muted}`}
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
      {children}
    </div>
  );
}

function Step({ tag, text }: { tag: string; text: string }) {
  return (
    <>
      <span className={muted}>stardust</span>
      <span className={muted}>{tag}</span>
      <span>{text}</span>
    </>
  );
}

function Terminal() {
  const { command, steps, running, results, failure, summary, end } =
    exampleRun;

  return (
    <div className="space-y-3 max-lg:w-max lg:pt-6">
      <p>
        <span className={`${muted} select-none`}>$ </span>
        {command}
      </p>

      <div className="grid grid-cols-[auto_auto_1fr] gap-x-3">
        {steps.map((step) => (
          <Step key={step.tag} {...step} />
        ))}
      </div>

      <div>
        <p>{running}</p>
        <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3">
          {results.map((r) => (
            <div key={r.id} className="contents">
              <span className={r.passed ? green : red}>
                {r.passed ? '✓' : '✘'} {r.id}
              </span>
              <span>
                <span className={muted}>{r.location} › </span>
                {r.name}
                <span className={muted}> ({r.time})</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className={red}>{failure.title}</p>
        <div className="ps-4">
          {failure.error.map((line, i) => (
            <p
              key={line}
              className={i === 0 ? red : 'ps-4 lg:whitespace-pre-wrap'}
            >
              {line.trimStart()}
            </p>
          ))}
        </div>
        <div className="ps-4">
          <p className={muted}>Timeline:</p>
          <div className="grid grid-cols-[auto_auto_auto_1fr] gap-x-3 ps-4">
            {failure.timeline.flatMap((entry) =>
              (entry.lines.length ? entry.lines : ['']).map((line, i) => (
                <div
                  key={`${entry.time}-${entry.label}-${i}`}
                  className="contents"
                >
                  <span className={muted}>{i === 0 ? entry.time : ''}</span>
                  <span className={muted}>{i === 0 ? failure.user : ''}</span>
                  <span>{i === 0 ? entry.label : ''}</span>
                  <span
                    className={
                      line.includes('https://')
                        ? 'min-w-0 overflow-hidden text-ellipsis whitespace-pre'
                        : 'min-w-0 whitespace-pre lg:whitespace-pre-wrap'
                    }
                  >
                    {line}
                  </span>
                </div>
              )),
            )}
          </div>
          <p className={`mt-1 ${muted}`}>{failure.folder}</p>
        </div>
      </div>

      <div>
        <p className={red}>{summary.failed}</p>
        <p className="ps-4">{failure.title.slice(3)}</p>
        <p className={green}>{summary.passed}</p>
      </div>

      <div className="grid grid-cols-[auto_auto_1fr] gap-x-3">
        <Step {...end} />
      </div>
    </div>
  );
}

export function Example() {
  return (
    <div className="rounded-[22px] border border-fd-border bg-fd-muted/50 p-1.5 shadow-2xl shadow-black/5 dark:bg-white/[0.025] dark:shadow-black/40">
      <div className="grid overflow-hidden rounded-2xl border border-fd-border bg-fd-card lg:h-[560px] lg:grid-cols-[1.08fr_1fr]">
        <div className="relative flex min-h-0 min-w-0 flex-col border-fd-border max-lg:border-b lg:border-e">
          <PaneTitle icon={FileCode2}>{exampleFile}</PaneTitle>
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin] max-lg:max-h-[420px] [&_figure]:my-0 [&_figure]:rounded-none [&_figure]:border-0 [&_figure]:bg-transparent [&_figure]:shadow-none [&_pre]:pb-10 [&_pre]:text-[12px] [&_pre]:leading-[1.6]">
            <ServerCodeBlock
              code={exampleTest}
              lang="ts"
              codeblock={{
                allowCopy: false,
                viewportProps: { className: 'max-h-none' },
              }}
            />
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-fd-card to-transparent"
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-col bg-fd-background/40">
          <PaneTitle icon={SquareTerminal}>Terminal</PaneTitle>
          <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto p-4 lg:[mask-image:linear-gradient(to_bottom,transparent,black_40px)] font-mono text-[12px] leading-[1.55] text-fd-foreground/90 [scrollbar-width:thin] max-lg:overflow-x-auto max-lg:whitespace-nowrap">
            <Terminal />
          </div>
        </div>
      </div>
    </div>
  );
}
