import type { HTMLAttributes, ReactNode } from 'react';

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  dot?: boolean;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}

export function StatusBadge({
  children,
  className = '',
  dot = true,
  tone = 'neutral',
  ...props
}: StatusBadgeProps) {
  const classes = ['ui-status-badge', `ui-status-badge--${tone}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span {...props} className={classes}>
      {dot ? <span aria-hidden="true" className="ui-status-badge__dot" /> : null}
      {children}
    </span>
  );
}
