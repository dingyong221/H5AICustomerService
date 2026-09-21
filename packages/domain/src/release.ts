export const releaseStatuses = [
  'validating',
  'building',
  'ready',
  'active',
  'retired',
  'failed',
] as const;

export type ReleaseStatus = (typeof releaseStatuses)[number];

const allowedTransitions: Readonly<Record<ReleaseStatus, readonly ReleaseStatus[]>> = {
  validating: ['building', 'failed'],
  building: ['ready', 'failed'],
  ready: ['active', 'failed'],
  active: ['retired'],
  retired: ['active'],
  failed: [],
};

export class InvalidReleaseTransitionError extends Error {
  public constructor(from: ReleaseStatus, to: ReleaseStatus) {
    super(`Release cannot transition from ${from} to ${to}`);
    this.name = 'InvalidReleaseTransitionError';
  }
}

export const canTransitionRelease = (from: ReleaseStatus, to: ReleaseStatus): boolean =>
  allowedTransitions[from].includes(to);

export const assertReleaseTransition = (from: ReleaseStatus, to: ReleaseStatus): void => {
  if (!canTransitionRelease(from, to)) {
    throw new InvalidReleaseTransitionError(from, to);
  }
};
