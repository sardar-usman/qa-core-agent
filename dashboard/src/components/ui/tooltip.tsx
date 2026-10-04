import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

/**
 * shadcn Tooltip over @radix-ui/react-tooltip. The provider (App.tsx) sets
 * the 300 ms delay. Radix keeps it keyboard accessible: a focusable trigger
 * opens it on focus, and the trigger gets aria-describedby pointing at the
 * content while it is open.
 */
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<React.ElementRef<typeof TooltipPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn('tip-enter z-50 max-w-xs rounded-md border border-line-strong bg-bg-3 px-3 py-2 text-s font-normal normal-case leading-snug tracking-normal text-fg shadow-lift', className)}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
