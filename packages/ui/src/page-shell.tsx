import type { ReactNode } from 'react';

export interface PageShellProps {
  aside?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  eyebrow?: string;
  notice?: ReactNode;
  title: string;
}

export function PageShell({
  aside,
  children,
  description,
  eyebrow,
  notice,
  title,
}: PageShellProps) {
  return (
    <div className="ui-page-shell">
      {notice ? <div className="ui-page-shell__notice">{notice}</div> : null}
      <header className="ui-page-shell__header">
        <div className="ui-page-shell__heading">
          {eyebrow ? <p className="ui-page-shell__eyebrow">{eyebrow}</p> : null}
          <h1>{title}</h1>
          {description ? <div className="ui-page-shell__description">{description}</div> : null}
        </div>
        {aside ? <div className="ui-page-shell__aside">{aside}</div> : null}
      </header>
      <div className="ui-page-shell__content">{children}</div>
    </div>
  );
}
