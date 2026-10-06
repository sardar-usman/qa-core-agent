import type { ReactNode } from 'react';

/** The one page header: a title plus one line saying what the page is for, with room for controls on the right. */
export function PageHeader({ title, description, children, testid }: { title: ReactNode; description: ReactNode; children?: ReactNode; testid?: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3" data-testid={testid ?? 'page-header'}>
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-fg">{title}</h1>
        <p className="mt-1 max-w-2xl text-small text-fg-2">{description}</p>
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}
