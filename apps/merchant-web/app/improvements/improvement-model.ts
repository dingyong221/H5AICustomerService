import {
  improvementReasons,
  type AssistantEvaluationRun,
  type ImprovementEdit,
  type ImprovementState,
} from '@h5cs/domain';

export const improvementStateLabels: Readonly<Record<ImprovementState, string>> = {
  needs_correction: '待补充或修正',
  needs_evaluation: '待复测',
  needs_review: '待人工判定',
  failed: '未通过',
  ready_to_publish: '已验证待发布',
  published: '已上线',
};

export const improvementReasonLabels = {
  missing_information: '资料缺失，答不上来',
  wrong_answer: '回答有误或有未经确认的承诺',
  unclear_policy: '价格、优惠或政策条件不清',
  human_help: '需要人工处理或投诉跟进',
  complaint: '投诉，需要人工核实与跟进',
  other: '新增测试场景或其他问题',
} as const;

export type ImprovementActionState = Readonly<{
  error: string | null;
  message: string | null;
  improvementId: string | null;
  resultKey: string | null;
  outcome: 'idle' | 'rejected' | 'unknown' | 'confirmed';
}>;

export const emptyImprovementAction: ImprovementActionState = {
  error: null,
  message: null,
  improvementId: null,
  resultKey: null,
  outcome: 'idle',
};

const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function parseImprovementEdit(form: FormData): ImprovementEdit | null {
  const question = form.get('question');
  const expectedAnswer = form.get('expectedAnswer');
  const reason = form.get('reason');
  const notes = form.get('notes');
  if (
    typeof question !== 'string' ||
    !question.trim() ||
    question.length > 2_000 ||
    typeof expectedAnswer !== 'string' ||
    expectedAnswer.length > 2_000 ||
    typeof notes !== 'string' ||
    notes.length > 2_000 ||
    typeof reason !== 'string' ||
    !improvementReasons.includes(reason as ImprovementEdit['reason']) ||
    [question, expectedAnswer, notes].some((value) => controlCharacters.test(value))
  )
    return null;
  return {
    question: question.trim(),
    expectedAnswer: expectedAnswer.trim(),
    reason: reason as ImprovementEdit['reason'],
    notes: notes.trim(),
  };
}

export function positiveVersion(value: FormDataEntryValue | null): number | null {
  return typeof value === 'string' && /^[1-9][0-9]{0,9}$/u.test(value) ? Number(value) : null;
}

export function evaluationIsCurrent(
  run: AssistantEvaluationRun,
  current: {
    version: number;
    draftRevision: number;
    factsHash: string;
    promptTemplateVersion?: string;
    modelPolicyVersion?: string;
  },
): boolean {
  return (
    run.taskVersion === current.version &&
    run.draftRevision === current.draftRevision &&
    run.factsHash === current.factsHash &&
    (current.promptTemplateVersion === undefined ||
      run.promptTemplateVersion === current.promptTemplateVersion) &&
    (current.modelPolicyVersion === undefined ||
      run.modelPolicyVersion === current.modelPolicyVersion)
  );
}

export function actionableImprovementCount(
  counts: Readonly<Record<ImprovementState, number>>,
): number {
  return (
    counts.needs_correction +
    counts.needs_evaluation +
    counts.needs_review +
    counts.failed +
    counts.ready_to_publish
  );
}

export function improvementSourcePath(input: {
  merchantId: string;
  assistantId: string;
  sessionId: string;
  messageId: string;
}): string {
  if (Object.values(input).some((value) => !/^[0-9a-f]{32}$/u.test(value)))
    throw new Error('Invalid improvement source');
  return `/${input.merchantId}/improvements?assistant=${input.assistantId}&session=${input.sessionId}&message=${input.messageId}#create`;
}
