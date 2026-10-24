/** Local copy only. Never display a supplier or server diagnostic as customer guidance. */
export function consumerFailure(code: string | undefined, retryable: boolean) {
  if (code === 'RELEASE_WITHDRAWN') {
    return {
      message:
        '商家已撤回此前的客服资料，本次咨询已结束。请查看最新客服，或通过原购买渠道联系商家。',
      retryable: false,
      needsLatestVersion: true,
    };
  }
  if (code === 'RATE_LIMITED') {
    return {
      message: '咨询较多，请稍等片刻后重试。你的问题已保留在本页。',
      retryable,
      needsLatestVersion: false,
    };
  }
  return {
    message: retryable
      ? '暂时没有收到完整回复。你的问题已保留，可以重试回复；不会作为新问题重复提交。'
      : '这次暂时无法完成回复。你的问题仍显示在本页，可以继续提问或联系商家核实。',
    retryable,
    needsLatestVersion: false,
  };
}

export function replyProgress(phase: 'sending' | 'waiting', elapsedSeconds: number): string {
  if (phase === 'sending') return '正在发送问题，请稍候…';
  if (elapsedSeconds >= 45)
    return '回复仍在处理中，请勿重复发送。你可以保持此页等待，或稍后刷新恢复本次咨询。';
  if (elapsedSeconds >= 15) return '比平时稍久，AI 仍在整理回答。问题已收到，无需重复发送。';
  return '问题已收到，AI 正在根据商家资料整理回答…';
}

export function supportReference(requestId: string | undefined): string | null {
  return requestId && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(requestId)
    ? requestId.slice(-12)
    : null;
}

/** Only explicitly labelled telephone numbers become actions; arbitrary URLs stay plain text. */
export function publishedTelephoneNumbers(instructions: string): readonly string[] {
  if (instructions.length > 500 || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(instructions))
    return [];
  const numbers = new Set<string>();
  for (const match of instructions.matchAll(
    /(?:联系电话|客服热线|电话|手机|热线|tel)[：:\t ]*((?:\+?86[- ]?)?(?:1[3-9]\d{9}|400[- ]?\d{3}[- ]?\d{4}|0\d{2,3}[- ]?\d{7,8}))(?!\d)/giu,
  )) {
    const number = match[1]!.replace(/[- ]/gu, '');
    if (/^\+?\d{10,14}$/u.test(number)) numbers.add(number);
    if (numbers.size === 3) break;
  }
  return [...numbers];
}
