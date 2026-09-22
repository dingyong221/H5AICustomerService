import type { AssistantDraftSnapshot, ReleaseOperation } from './assistant-management-contract';
import type {
  AssistantDraftUpdate,
  AssistantManagementClientErrorKind,
} from './assistant-management-api-client';

export type AssistantManagementState =
  | 'conflict'
  | 'failed'
  | 'loading'
  | 'not_found'
  | 'published'
  | 'publishing'
  | 'ready'
  | 'unavailable';

export interface AssistantManagementViewModel {
  canCheck: boolean;
  canPublish: boolean;
  canSave: boolean;
  description: string;
  label: string;
  operationFailure?: Readonly<{ message: string; traceId?: string | undefined }> | undefined;
  publicHref?: string | undefined;
  publishBlocked: boolean;
  publishItems: readonly AssistantDraftSnapshot['publishCheck']['items'][number][];
  state: AssistantManagementState;
  tone: 'danger' | 'info' | 'neutral' | 'success' | 'warning';
}

export type AssistantDraftFieldErrors = Partial<Record<keyof AssistantDraftUpdate, string>>;

const publicSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62})$/u;

export function resolveSafePublicAssistantUrl(
  value: string,
  applicationOrigin: string,
): string | undefined {
  try {
    const origin = new URL(applicationOrigin);
    const target = new URL(value, origin);
    const segments = target.pathname.split('/');
    const slug = segments.length === 3 && segments[1] === 'a' ? segments[2] : undefined;
    if (
      target.origin !== origin.origin ||
      target.username.length > 0 ||
      target.password.length > 0 ||
      target.search.length > 0 ||
      target.hash.length > 0 ||
      slug === undefined ||
      !publicSlugPattern.test(slug)
    ) {
      return undefined;
    }
    return target.href;
  } catch {
    return undefined;
  }
}

export function validateAssistantDraftUpdate(
  value: AssistantDraftUpdate,
): AssistantDraftFieldErrors {
  const errors: AssistantDraftFieldErrors = {};
  const validate = (field: keyof AssistantDraftUpdate, maximum: number, label: string) => {
    const normalized = value[field].trim();
    if (normalized.length === 0) errors[field] = `${label}不能为空`;
    else if (normalized.length > maximum)
      errors[field] = `${label}不能超过 ${String(maximum)} 个字符`;
    else if (/[\u0000-\u001F\u007F]/u.test(normalized)) errors[field] = `${label}包含无效字符`;
  };
  validate('assistantName', 80, '客服名称');
  validate('businessScope', 500, '业务范围');
  validate('welcomeMessage', 500, '欢迎语');
  validate('insufficientInfoMessage', 500, '资料不足策略');
  return errors;
}

function stateForError(errorKind: AssistantManagementClientErrorKind | undefined) {
  if (errorKind === 'not_found' || errorKind === 'forbidden') return 'not_found' as const;
  if (errorKind === 'conflict') return 'conflict' as const;
  return 'unavailable' as const;
}

export function buildAssistantManagementViewModel(input: {
  applicationOrigin: string;
  errorKind?: AssistantManagementClientErrorKind | undefined;
  loading?: boolean | undefined;
  operation?: ReleaseOperation | null | undefined;
  snapshot?: AssistantDraftSnapshot | undefined;
}): AssistantManagementViewModel {
  if (input.snapshot === undefined) {
    const state = input.loading === true ? 'loading' : stateForError(input.errorKind);
    const presentation =
      state === 'loading'
        ? {
            description: '正在从服务端读取草稿、发布检查和当前 Release。',
            label: '正在读取可信快照',
            tone: 'info' as const,
          }
        : state === 'not_found'
          ? {
              description: '客服不存在或当前账号无权访问，页面不会泄露资源归属。',
              label: '客服不可访问',
              tone: 'danger' as const,
            }
          : state === 'conflict'
            ? {
                description: '草稿 revision 已变化，请重新读取后再编辑或发布。',
                label: '草稿版本冲突',
                tone: 'warning' as const,
              }
            : {
                description: '管理服务未配置、不可达或返回了无法验证的数据。',
                label: '客服管理不可用',
                tone: 'neutral' as const,
              };
    return {
      ...presentation,
      canCheck: false,
      canPublish: false,
      canSave: false,
      publishBlocked: true,
      publishItems: [],
      state,
    };
  }

  if (input.errorKind !== undefined) {
    const state = stateForError(input.errorKind);
    const presentation =
      state === 'not_found'
        ? {
            description: '访问权已失效，必须重新读取并由服务端重新裁决。',
            label: '客服不可访问',
            tone: 'danger' as const,
          }
        : state === 'conflict'
          ? {
              description: '草稿 revision 已变化，旧 ETag 不能继续保存或发布。',
              label: '草稿版本冲突',
              tone: 'warning' as const,
            }
          : {
              description: '最近一次请求没有得到可信确认，所有写操作已暂停。',
              label: '等待重新确认服务端状态',
              tone: 'neutral' as const,
            };
    return {
      ...presentation,
      canCheck: true,
      canPublish: false,
      canSave: false,
      publishBlocked: true,
      publishItems: input.snapshot.publishCheck.items,
      state,
    };
  }

  const operation = input.operation === undefined ? input.snapshot.publication : input.operation;
  const publishing = operation?.state === 'accepted' || operation?.state === 'processing';
  const publishBlocked = input.snapshot.publishCheck.state !== 'ready';
  let state: AssistantManagementState = publishBlocked ? 'failed' : 'ready';
  let label = publishBlocked ? '发布检查未通过' : '草稿可检查发布';
  let description = publishBlocked
    ? '必须先解决所有阻断项；当前线上 Release 不会改变。'
    : '草稿已从服务端加载，仍需明确确认后才能发起发布。';
  let tone: AssistantManagementViewModel['tone'] = publishBlocked ? 'warning' : 'neutral';
  let publicHref: string | undefined;
  let operationFailure: AssistantManagementViewModel['operationFailure'];

  if (publishing) {
    state = 'publishing';
    label = operation.state === 'accepted' ? '发布已受理' : '正在发布';
    description = '页面正在轮询服务端操作；离开页面不会取消已提交的发布。';
    tone = 'info';
  } else if (operation?.state === 'succeeded') {
    state = 'published';
    label = `Release #${String(operation.result.releaseNo)} 已发布`;
    description = '服务端确认发布操作成功，固定公开入口现在可以使用。';
    tone = 'success';
    publicHref = resolveSafePublicAssistantUrl(operation.result.publicUrl, input.applicationOrigin);
  } else if (operation?.state === 'failed') {
    state = 'failed';
    label = '发布失败';
    description = '服务端确认发布未完成，当前线上 Release 保持不变。';
    tone = 'danger';
    operationFailure = {
      message: operation.failure.message,
      ...(operation.failure.traceId === undefined ? {} : { traceId: operation.failure.traceId }),
    };
  }

  return {
    canCheck: !publishing,
    canPublish: !publishing && !publishBlocked,
    canSave: !publishing,
    description,
    label,
    ...(operationFailure === undefined ? {} : { operationFailure }),
    ...(publicHref === undefined ? {} : { publicHref }),
    publishBlocked,
    publishItems: input.snapshot.publishCheck.items,
    state,
    tone,
  };
}
