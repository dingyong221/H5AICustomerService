import type { FollowUpStatus } from '@h5cs/database';

export const followUpLabel = (status: FollowUpStatus): string => {
  if (status === 'pending') return '待处理';
  if (status === 'in_progress') return '处理中';
  return '已处理';
};

export const validFollowUpStatus = (value: string | undefined): FollowUpStatus | null => {
  if (value === 'pending' || value === 'in_progress' || value === 'resolved') return value;
  return null;
};
