export const conversationPrivacyNotice =
  '为便于继续咨询和刷新恢复，系统会保存当前咨询的消息和上下文。此窗口不能代办删除记录；请勿发送密码、验证码或其他敏感信息。';

export function conversationPrivacyReply(question: string): string | null {
  const text = question.normalize('NFKC');
  return /保存|留存|存储|记录|收集|删除|清除|隐私/u.test(text) &&
    /聊天|对话|咨询|会话|消息|记录|个人信息|我的信息|隐私|数据/u.test(text)
    ? conversationPrivacyNotice
    : null;
}

/** Keep correct product answers while replacing unverified data-handling promises. */
export function correctPrivacyPromises(answer: string): string {
  const falsePromise =
    /(?:不会|不再|从不|不|无需|没有)[^，,。！？!?；;\n]{0,24}(?:保存|记录|存储|留存|收集)[^，,。！？!?；;\n]{0,20}(?:信息|聊天|对话|消息|记录|数据|内容)|(?:已经|已|成功)[^，,。！？!?；;\n]{0,12}(?:删除|清除|擦除)[^，,。！？!?；;\n]{0,20}(?:信息|聊天|对话|消息|记录|数据|内容)|(?:聊天|对话|消息|记录|数据|信息)[^，,。！？!?；;\n]{0,12}(?:已删除|已清除)/u;
  const clauses = answer.match(/[^，,。！？!?；;\n]+[，,。！？!?；;\n]*/gu) ?? [answer];
  let corrected = false;
  const retained = clauses
    .filter((clause) => {
      if (!falsePromise.test(clause)) return true;
      corrected = true;
      return false;
    })
    .join('')
    .trim();
  return corrected ? [retained, conversationPrivacyNotice].filter(Boolean).join('\n') : answer;
}
