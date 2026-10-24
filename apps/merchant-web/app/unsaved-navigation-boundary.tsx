'use client';

import { useEffect } from 'react';
import { installUnsavedHistoryGuard, unsavedHistoryScope } from './workspace/unsaved-history-guard';

/** Mount once in the shared layout so clean pages also receive history indexes. */
export function UnsavedNavigationBoundary() {
  useEffect(() => installUnsavedHistoryGuard(window, unsavedHistoryScope(window)), []);
  return null;
}
