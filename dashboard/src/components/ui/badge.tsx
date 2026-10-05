import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-s font-semibold leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent', {
  variants: {
    variant: {
      neutral: 'border-transparent bg-neutral-soft text-neutral',
      pass: 'border-transparent bg-pass-soft text-pass',
      rework: 'border-transparent bg-rework-soft text-rework',
      reject: 'border-transparent bg-reject-soft text-reject',
      finding: 'border-transparent bg-finding-soft text-finding',
      accent: 'border-transparent bg-accent-soft text-accent',
      outline: 'border-line-strong text-fg-2',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

/** forwardRef so a Badge can be a tooltip trigger (Radix Slot passes a ref through). */
const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
));
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
