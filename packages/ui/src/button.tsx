import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean;
  children: ReactNode;
  size?: 'small' | 'medium';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}

export function Button({
  busy = false,
  children,
  className = '',
  disabled,
  size = 'medium',
  type = 'button',
  variant = 'primary',
  ...props
}: ButtonProps) {
  const classes = ['ui-button', `ui-button--${variant}`, `ui-button--${size}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...props}
      aria-busy={busy || undefined}
      className={classes}
      disabled={disabled || busy}
      type={type}
    >
      {busy ? <span aria-hidden="true" className="ui-button__spinner" /> : null}
      <span>{children}</span>
    </button>
  );
}
