import type { AssistantDraftConfig } from './assistant-lifecycle-repository.js';

export const improvementReasons = [
  'missing_information',
  'wrong_answer',
  'unclear_policy',
  'human_help',
  'complaint',
  'other',
] as const;
export type ImprovementReason = (typeof improvementReasons)[number];
export type ImprovementState =
  | 'needs_correction'
  | 'needs_evaluation'
  | 'needs_review'
  | 'failed'
  | 'ready_to_publish'
  | 'published';
export type ImprovementEvaluationPolicy = Readonly<{
  promptTemplateVersion: string;
  modelPolicyVersion: string;
}>;
export type ImprovementActor = Readonly<{
  merchantId: string;
  merchantUserId: string;
  assistantId: string;
}>;
export type ImprovementWrite = ImprovementActor & Readonly<{ requestKey: string; now: Date }>;
export type ImprovementEdit = Readonly<{
  reason: ImprovementReason;
  question: string;
  expectedAnswer: string;
  notes: string;
}>;
export type AssistantImprovement = ImprovementEdit &
  Readonly<{
    id: string;
    merchantId: string;
    assistantId: string;
    version: number;
    sourceSessionId: string | null;
    sourceMessageId: string | null;
    sourceReleaseId: string | null;
    originalAnswer: string | null;
    appliedBlock: string | null;
    appliedDraftRevision: number | null;
    publishedReleaseId: string | null;
    publishedTaskVersion: number | null;
    createdAt: Date;
    updatedAt: Date;
    state: ImprovementState;
  }>;
export type AssistantEvaluationRun = Readonly<{
  id: string;
  improvementId: string;
  taskVersion: number;
  draftRevision: number;
  factsHash: string;
  question: string;
  expectedAnswer: string;
  answer: string | null;
  errorCode: string | null;
  state: 'pending' | 'completed' | 'failed';
  verdict: 'pass' | 'fail' | null;
  reviewedAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
  promptTemplateVersion: string;
  modelPolicyVersion: string;
}>;
export type ImprovementDetail = Readonly<{
  improvement: AssistantImprovement;
  runs: readonly AssistantEvaluationRun[];
  currentDraftRevision: number;
  currentFactsHash: string;
}>;
export type ImprovementList = Readonly<{
  items: readonly AssistantImprovement[];
  counts: Readonly<Record<ImprovementState, number>>;
  total: number;
  truncated: boolean;
}>;
export type StartedEvaluation = Readonly<{
  run: AssistantEvaluationRun;
  draft: AssistantDraftConfig;
  assistantName: string;
  started: boolean;
}>;

/** Repository calls are server-only. finishEvaluation must never accept browser-supplied answers. */
export interface AssistantImprovementRepository {
  list(
    input: Omit<ImprovementActor, 'assistantId'> & { assistantId?: string },
  ): Promise<ImprovementList>;
  detail(input: ImprovementActor & { improvementId: string }): Promise<ImprovementDetail | null>;
  createFromMessage(
    input: ImprovementWrite & ImprovementEdit & { sourceMessageId: string },
  ): Promise<AssistantImprovement>;
  createScenario(input: ImprovementWrite & ImprovementEdit): Promise<AssistantImprovement>;
  update(
    input: ImprovementWrite & ImprovementEdit & { improvementId: string; expectedVersion: number },
  ): Promise<AssistantImprovement>;
  applyCorrection(
    input: ImprovementWrite & {
      improvementId: string;
      expectedVersion: number;
      expectedDraftRevision: number;
    },
  ): Promise<{ improvement: AssistantImprovement; draftRevision: number }>;
  startEvaluation(
    input: ImprovementWrite & {
      improvementId: string;
      expectedVersion: number;
      expectedDraftRevision: number;
      promptTemplateVersion: string;
      modelPolicyVersion: string;
    },
  ): Promise<StartedEvaluation>;
  finishEvaluation(
    input: ImprovementWrite & {
      improvementId: string;
      runId: string;
      answer: string | null;
      errorCode: string | null;
    },
  ): Promise<AssistantEvaluationRun>;
  reviewEvaluation(
    input: ImprovementWrite & {
      improvementId: string;
      runId: string;
      expectedVersion: number;
      expectedDraftRevision: number;
      verdict: 'pass' | 'fail';
    },
  ): Promise<AssistantEvaluationRun>;
}

export class ImprovementConflictError extends Error {
  public constructor(
    public readonly code:
      | 'unavailable'
      | 'stale'
      | 'invalid'
      | 'too_long'
      | 'managed_block_changed'
      | 'idempotency_conflict' = 'stale',
  ) {
    super(`Assistant improvement ${code}`);
    this.name = 'ImprovementConflictError';
  }
}

/** Exact replacement only: merchant edits to a managed block require an explicit manual review. */
export function applyImprovementFaq(input: {
  materials: string;
  improvementId: string;
  question: string;
  expectedAnswer: string;
  previousBlock: string | null;
}): { materials: string; block: string } {
  if (
    !/^[0-9a-f]{32}$/u.test(input.improvementId) ||
    !input.question.trim() ||
    !input.expectedAnswer.trim() ||
    input.question.length > 2_000 ||
    input.expectedAnswer.length > 2_000
  )
    throw new ImprovementConflictError('invalid');
  const begin = `[FAQ-${input.improvementId}]`;
  const end = `[/FAQ-${input.improvementId}]`;
  if (
    [input.question, input.expectedAnswer].some(
      (value) => value.includes('[FAQ-') || value.includes('[/FAQ-'),
    )
  )
    throw new ImprovementConflictError('invalid');
  const block = `${begin}\n问：${input.question.trim()}\n答：${input.expectedAnswer.trim()}\n${end}`;
  let materials: string;
  if (input.previousBlock !== null) {
    if (
      !input.materials.includes(input.previousBlock) ||
      input.materials.indexOf(begin) !== input.materials.lastIndexOf(begin) ||
      input.materials.indexOf(end) !== input.materials.lastIndexOf(end)
    )
      throw new ImprovementConflictError('managed_block_changed');
    materials = input.materials.replace(input.previousBlock, block);
  } else {
    if (input.materials.includes(begin) || input.materials.includes(end))
      throw new ImprovementConflictError('managed_block_changed');
    materials = `${input.materials}${input.materials ? '\n\n' : ''}${block}`;
  }
  if (materials.length > 4_000) throw new ImprovementConflictError('too_long');
  return { materials, block };
}

export function deriveImprovementState(input: {
  taskVersion: number;
  expectedAnswer: string;
  appliedBlock: string | null;
  appliedDraftRevision: number | null;
  publishedTaskVersion: number | null;
  publishedReleaseId: string | null;
  activeReleaseId: string | null;
  currentDraftRevision: number;
  currentFactsHash: string;
  latestRun: AssistantEvaluationRun | null;
  currentPolicy?: ImprovementEvaluationPolicy;
}): ImprovementState {
  if (!input.expectedAnswer.trim() || !input.appliedBlock || input.appliedDraftRevision === null)
    return 'needs_correction';
  const run = input.latestRun;
  if (
    !run ||
    run.taskVersion !== input.taskVersion ||
    run.draftRevision !== input.currentDraftRevision ||
    run.factsHash !== input.currentFactsHash ||
    run.state === 'pending'
  )
    return 'needs_evaluation';
  if (
    input.currentPolicy &&
    (run.promptTemplateVersion !== input.currentPolicy.promptTemplateVersion ||
      run.modelPolicyVersion !== input.currentPolicy.modelPolicyVersion)
  )
    return 'needs_evaluation';
  if (run.state === 'failed' || run.verdict === 'fail') return 'failed';
  if (
    run.verdict === 'pass' &&
    input.publishedTaskVersion === input.taskVersion &&
    input.publishedReleaseId !== null &&
    input.publishedReleaseId === input.activeReleaseId
  )
    return 'published';
  return run.verdict === 'pass' ? 'ready_to_publish' : 'needs_review';
}
