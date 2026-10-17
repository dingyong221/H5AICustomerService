/** Only describe a revision confirmed by the server, never a click or pending action. */
export function draftRevisionStatus(
  openedRevision: number,
  currentRevision: number,
  knowledgeConfirmed: boolean,
): string | null {
  if (
    !Number.isSafeInteger(openedRevision) ||
    !Number.isSafeInteger(currentRevision) ||
    openedRevision < 1 ||
    currentRevision <= openedRevision
  )
    return null;
  return knowledgeConfirmed
    ? `草稿已更新至修订 ${currentRevision}，当前资料已确认。`
    : `草稿已保存至修订 ${currentRevision}，原有资料确认已失效。请核对新内容后重新确认。`;
}
