export function assistantListStatus(assistant: {
  activeReleaseId: string | null;
  knowledgeConfirmed: boolean;
  status: 'draft_only' | 'active' | 'paused';
}): string {
  const draft = assistant.knowledgeConfirmed ? '当前草稿资料已确认' : '当前草稿资料待确认';
  if (assistant.status === 'paused') return `客服已暂停；${draft}`;
  if (assistant.activeReleaseId) return `已有发布版本；${draft}`;
  return `尚未发布；${draft}`;
}
