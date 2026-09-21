import type { ReactNode } from 'react';

export interface EmptyStateProps {
  action?: ReactNode;
  className?: string;
  description: ReactNode;
  icon?: ReactNode;
  title: string;
}

export function EmptyState({ action, className = '', description, icon, title }: EmptyStateProps) {
  return (
    <section className={['ui-empty-state', className].filter(Boolean).join(' ')}>
      {icon ? (
        <div aria-hidden="true" className="ui-empty-state__icon">
          {icon}
        </div>
      ) : null}
      <h2 className="ui-empty-state__title">{title}</h2>
      <div className="ui-empty-state__description">{description}</div>
      {action ? <div className="ui-empty-state__action">{action}</div> : null}
    </section>
  );
}
