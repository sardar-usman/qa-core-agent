import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { GLOSSARY, type GlossaryKey } from '@/lib/glossary';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * Tooltip helpers. All glossary text lives in lib/glossary.ts; these only
 * render it. Every trigger carries data-glossary="<key>" (or data-tip for a
 * value tooltip) so the smokes can match a trigger to its entry without
 * hovering, and the hover check can compare the rendered text to the entry.
 */

/**
 * A glossary term as inline text: no underline at rest, a dotted underline
 * on hover and on keyboard focus, focusable, opens the definition.
 */
export function Term({ term, children, className }: { term: GlossaryKey; children?: ReactNode; className?: string }) {
  const g = GLOSSARY[term];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-glossary={term} className={cn('cursor-help rounded-sm decoration-line-strong decoration-dotted underline-offset-[3px] hover:underline focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', className)}>{children ?? g.term}</span>
      </TooltipTrigger>
      <TooltipContent><TermBody term={term} /></TooltipContent>
    </Tooltip>
  );
}

const INFO_ICON = 'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-fg-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** A small info icon that opens a glossary entry (a form label, a card metric label). */
export function InfoTerm({ term, className }: { term: GlossaryKey; className?: string }) {
  const g = GLOSSARY[term];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" data-glossary={term} aria-label={`About ${g.term}`} className={cn(INFO_ICON, className)}>
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent><TermBody term={term} /></TooltipContent>
    </Tooltip>
  );
}

/** A small info icon that opens a value tooltip (a note built from stored numbers, so it is not a glossary entry). */
export function InfoTip({ text, label, className, testid }: { text: string; label: string; className?: string; testid?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" data-tip={text} aria-label={label} className={cn(INFO_ICON, className)} data-testid={testid}>
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="break-words">{text}</TooltipContent>
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

/**
 * A value tooltip (the exact figure behind a rounded one, a full timestamp,
 * a full URL). With `asChild` the child itself is the trigger (a link, a
 * button); otherwise a focusable span wraps the children.
 */
export function Tip({ text, children, className, asChild = false, mono = false }: { text: string; children: ReactNode; className?: string; asChild?: boolean; mono?: boolean }) {
  return (
    <Tooltip>
      {asChild ? (
        <TooltipTrigger asChild data-tip={text}>{children}</TooltipTrigger>
      ) : (
        <TooltipTrigger asChild>
          <span tabIndex={0} data-tip={text} className={cn('cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', className)}>{children}</span>
        </TooltipTrigger>
      )}
      <TooltipContent className={cn('break-words', mono && 'mono')}>{text}</TooltipContent>
    </Tooltip>
  );
}

function TermBody({ term }: { term: GlossaryKey }) {
  const g = GLOSSARY[term];
  return <><span className="font-medium">{g.term}.</span> {g.text}</>;
}
