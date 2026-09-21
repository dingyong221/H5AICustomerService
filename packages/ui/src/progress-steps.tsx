import type { ReactNode } from 'react';

export type ProgressStepStatus = 'complete' | 'current' | 'upcoming' | 'paused' | 'blocked';

export interface ProgressStep {
  description?: ReactNode;
  id: string;
  label: string;
  status: ProgressStepStatus;
}

export interface ProgressStepsProps {
  ariaLabel: string;
  className?: string;
  steps: readonly ProgressStep[];
}

export function ProgressSteps({ ariaLabel, className = '', steps }: ProgressStepsProps) {
  return (
    <ol
      aria-label={ariaLabel}
      className={['ui-progress-steps', className].filter(Boolean).join(' ')}
    >
      {steps.map((step, index) => (
        <li
          aria-current={step.status === 'current' ? 'step' : undefined}
          className={`ui-progress-steps__item ui-progress-steps__item--${step.status}`}
          key={step.id}
        >
          <span aria-hidden="true" className="ui-progress-steps__marker">
            {step.status === 'complete' ? '✓' : index + 1}
          </span>
          <span className="ui-progress-steps__copy">
            <strong>{step.label}</strong>
            {step.description ? <small>{step.description}</small> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
