import type { ReactNode } from 'react';

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong bg-bg-1 px-6 py-14 text-center" data-testid="empty-state">
      {icon ? <div className="mb-3 text-fg-3">{icon}</div> : null}
      <div className="text-m font-semibold">{title}</div>
      {children ? <div className="mt-2 max-w-md text-s text-fg-2">{children}</div> : null}
    </div>
  );
}
