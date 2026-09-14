import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-s font-semibold', {
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

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
