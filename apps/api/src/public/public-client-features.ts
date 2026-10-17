/** Additive snapshot fields require explicit negotiation for already-open strict legacy clients. */
export function publicSnapshotForClient<T extends Readonly<{ humanContact?: string }>>(
  snapshot: T,
  features: string | undefined,
): Omit<T, 'humanContact'> | T {
  if (
    typeof features === 'string' &&
    features.length <= 500 &&
    features.split(/[\s,]+/u).includes('human-contact')
  ) {
    return snapshot;
  }
  const { humanContact: _contact, ...legacy } = snapshot;
  return legacy;
}
