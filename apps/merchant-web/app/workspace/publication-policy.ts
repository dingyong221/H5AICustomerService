export type PublicationPolicy =
  | Readonly<{ ready: false; reason: string }>
  | Readonly<{
      ready: true;
      consumerOrigin: string;
      promptTemplateVersion: string;
      retrievalPolicyVersion: string;
      modelPolicyVersion: string;
    }>;

const version = (value: string | undefined): string | null =>
  value &&
  value.length <= 64 &&
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) &&
  !value.startsWith('replace-')
    ? value
    : null;

const consumerOrigin = (value: string | undefined, production: boolean): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (
      url.origin !== value ||
      (url.protocol !== 'https:' && (production || url.protocol !== 'http:' || !loopback))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
};

export function publicationPolicy(environment: NodeJS.ProcessEnv = process.env): PublicationPolicy {
  if (environment['PUBLIC_CONVERSATION_ENABLED'] !== 'true') {
    return { ready: false, reason: '公开对话尚未完成端到端验证，暂不可发布。' };
  }
  const origin = consumerOrigin(
    environment['CONSUMER_H5_ORIGIN'],
    environment['NODE_ENV'] === 'production',
  );
  if (!origin) return { ready: false, reason: '消费者 H5 正式域名尚未正确配置。' };
  const provider = environment['MODEL_PROVIDER'];
  const model = environment['MODEL_NAME'];
  if (
    provider !== 'chat_completions' ||
    environment['CONVERSATION_WORKER_ENABLED'] !== 'true' ||
    !model ||
    model.trim() !== model ||
    model.startsWith('replace-')
  ) {
    return { ready: false, reason: '正式模型服务尚未配置。' };
  }
  const promptTemplateVersion = version(environment['PUBLISH_PROMPT_TEMPLATE_VERSION']);
  const retrievalPolicyVersion = version(environment['PUBLISH_RETRIEVAL_POLICY_VERSION']);
  const modelPolicyVersion = version(environment['PUBLISH_MODEL_POLICY_VERSION']);
  if (!promptTemplateVersion || !retrievalPolicyVersion || !modelPolicyVersion) {
    return { ready: false, reason: '发布策略版本尚未配置。' };
  }
  return {
    ready: true,
    consumerOrigin: origin,
    promptTemplateVersion,
    retrievalPolicyVersion,
    modelPolicyVersion,
  };
}

export function publicAssistantUrl(origin: string, publicSlug: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(publicSlug)) return null;
  return `${origin}/a/${publicSlug}`;
}
