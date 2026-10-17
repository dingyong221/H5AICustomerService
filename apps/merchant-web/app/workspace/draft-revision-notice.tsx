'use client';

import { useState } from 'react';

import { draftRevisionStatus } from './draft-revision-status';

/** Kept outside the revision-keyed editor so a successful RSC refresh retains feedback. */
export function DraftRevisionNotice({
  revision,
  knowledgeConfirmed,
}: {
  revision: number;
  knowledgeConfirmed: boolean;
}) {
  const [openedRevision] = useState(revision);
  const message = draftRevisionStatus(openedRevision, revision, knowledgeConfirmed);
  return message ? <p role="status">{message}</p> : null;
}
