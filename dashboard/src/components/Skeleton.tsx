import { cn } from '@/lib/utils';

/** A loading placeholder block. Decorative only: hidden from assistive tech, the container announces busy. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton rounded-md', className)} />;
}

/** The Projects grid while /api/projects loads. */
export function ProjectsSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-live="polite" aria-busy="true" aria-label="Loading projects" data-testid="projects-skeleton">
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="rounded-lg border border-line bg-bg-1 p-6">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="mt-2 h-3 w-3/5" />
          <Skeleton className="mt-6 h-8 w-16" />
          <Skeleton className="mt-2 h-3 w-1/2" />
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The Runs table while /api/runs loads. */
export function TableSkeleton({ rows = 8, cols = 8 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-lg border border-line bg-bg-1" role="status" aria-live="polite" aria-busy="true" aria-label="Loading runs" data-testid="table-skeleton">
      <div className="flex gap-4 border-b border-line bg-bg-2 px-4 py-3">
        {Array.from({ length: cols }, (_, i) => <Skeleton key={i} className="h-3 flex-1" />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-line px-4 py-4 last:border-0">
          {Array.from({ length: cols }, (_, c) => <Skeleton key={c} className={cn('h-3 flex-1', c === 1 && 'h-4')} />)}
        </div>
      ))}
    </div>
  );
}
