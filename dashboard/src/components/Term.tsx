import type { ReactNode } from 'react';
import { GLOSSARY, type GlossaryKey } from '@/lib/glossary';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Tooltip helpers. All glossary text lives in lib/glossary.ts; these only
 * render it. Every trigger carries data-glossary="<key>" (or data-tip for a
 * value tooltip) so the smokes can match a trigger to its entry without
 * hovering, and the hover check can compare the rendered text to the entry.
 */

/** A glossary term as inline text: dotted underline, focusable, opens the definition. */
export function Term({ term, children, className }: { term: GlossaryKey; children?: ReactNode; className?: string }) {
  const g = GLOSSARY[term];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-glossary={term} className={cn('cursor-help rounded-sm underline decoration-line-strong decoration-dotted underline-offset-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', className)}>{children ?? g.term}</span>
      </TooltipTrigger>
      <TooltipContent><TermBody term={term} /></TooltipContent>
    </Tooltip>
  );
}

/** Wraps an existing element (a button, a badge) with a glossary tooltip; the child must be focusable. */
export function TermTip({ term, children }: { term: GlossaryKey; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild data-glossary={term}>{children}</TooltipTrigger>
      <TooltipContent><TermBody term={term} /></TooltipContent>
    </Tooltip>
  );
}

/** A value tooltip (the exact figure behind a rounded one, a full timestamp). */
export function Tip({ text, children, className }: { text: string; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-tip={text} className={cn('cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent className="mono">{text}</TooltipContent>
    </Tooltip>
  );
}

function TermBody({ term }: { term: GlossaryKey }) {
  const g = GLOSSARY[term];
  return <><span className="font-semibold">{g.term}.</span> {g.text}</>;
}
