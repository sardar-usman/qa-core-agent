import type { ReactNode } from 'react';

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong bg-bg-1 px-6 py-16 text-center" data-testid="empty-state">
      {icon ? <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-bg-3 text-fg-2">{icon}</div> : null}
      <div className="text-subheading font-semibold text-fg">{title}</div>
      {children ? <div className="mt-2 max-w-md text-small text-fg-2">{children}</div> : null}
    </div>
  );
}
