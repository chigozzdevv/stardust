'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="group inline-flex items-center gap-2.5 rounded-full border border-fd-border px-3.5 py-1.5 font-mono text-xs text-fd-muted-foreground transition-colors hover:border-fd-foreground/25 hover:text-fd-foreground"
      aria-label={`Copy "${command}"`}
    >
      <span className="select-none">$</span>
      <span>{command}</span>
      {copied ? (
        <Check className="size-3.5 text-emerald-500" />
      ) : (
        <Copy className="size-3.5 opacity-50 group-hover:opacity-100" />
      )}
    </button>
  );
}
