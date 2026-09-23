'use client';

import { type FormEvent, useMemo, useReducer, useState } from 'react';

import { Button, ProgressSteps, StatusBadge } from '@h5cs/ui';

import {
  createOnboardingApiClient,
  OnboardingClientError,
  type ExistingAssistantResult,
  type OnboardingStartResult,
} from './onboarding-api-client';
import {
  formSteps,
  initialOnboardingFormValues,
  initialOnboardingInteractionState,
  reduceOnboardingInteraction,
  validateAllOnboardingSteps,
  validateOnboardingStep,
  type FormErrors,
  type FormStep,
  type OnboardingFormValues,
} from './onboarding-form-model';
import { buildOnboardingViewModel, type WorkBuddyAuthorization } from './onboarding-view-model';
import { submitCompleteOnboarding } from './onboarding-submission';
import { clearWorkBuddyAccessToken, readWorkBuddyAccessToken } from './workbuddy-token-memory';

interface OnboardingFormProps {
  apiBaseUrl?: string;
  authorization: WorkBuddyAuthorization;
}

const stepIndex: Readonly<Record<FormStep, number>> = {
  confirmation: 3,
  industry: 0,
  materials: 1,
  policy: 2,
};

const statusLabels: Readonly<Record<string, string>> = {
  authentication_expired: '认证已过期',
  binding_required: '需要安全绑定',
  conflict: '状态冲突',
  editing: '尚未保存',
  error: '提交失败',
  existing: '已有客服',
  generated: '生成完成',
  generation_unavailable: '生成暂不可用',
  generating: '服务端生成中',
  merchant_selection_required: '需要选择商家',
  paused: '已暂停',
  pausing: '正在暂停',
  resuming: '正在恢复',
  saved: '服务端已保存',
  saving: '正在提交',
};

function createIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function FieldError({ error, id }: { error?: string | undefined; id: string }) {
  return error ? (
    <span className="field-error" id={id} role="alert">
      {error}
    </span>
  ) : null;
}

function statusTone(status: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'existing' || status === 'generated' || status === 'saved') return 'success';
  if (status === 'saving' || status === 'generating' || status === 'resuming') return 'info';
  if (
    status === 'conflict' ||
    status === 'authentication_expired' ||
    status === 'binding_required' ||
    status === 'merchant_selection_required' ||
    status === 'generation_unavailable' ||
    status === 'error'
  ) {
    return 'danger';
  }
  if (status === 'paused' || status === 'pausing') return 'warning';
  return 'neutral';
}

export function OnboardingForm({ apiBaseUrl, authorization }: OnboardingFormProps) {
  const [values, setValues] = useState<OnboardingFormValues>(initialOnboardingFormValues);
  const [errors, setErrors] = useState<FormErrors>({});
  const [currentStep, setCurrentStep] = useState<FormStep>('industry');
  const [existingManagement, setExistingManagement] = useState<ExistingAssistantResult | null>(
    null,
  );
  const [interaction, dispatch] = useReducer(
    reduceOnboardingInteraction,
    initialOnboardingInteractionState,
  );
  const apiConfigured = apiBaseUrl !== undefined && apiBaseUrl.trim().length > 0;
  const authorized = authorization === 'authorized';
  const busy =
    existingManagement !== null ||
    ['saving', 'generating', 'pausing', 'resuming'].includes(interaction.status);
  const canWrite = apiConfigured && authorized && !busy;
  const serverViewModel = buildOnboardingViewModel({
    apiConnected: apiConfigured,
    authorization,
    ...(interaction.result === undefined ? {} : { result: interaction.result }),
  });
  const displaySteps =
    interaction.result === undefined
      ? serverViewModel.steps.map((step, index) => ({
          ...step,
          status:
            index < stepIndex[currentStep]
              ? ('complete' as const)
              : index === stepIndex[currentStep]
                ? ('current' as const)
                : ('upcoming' as const),
        }))
      : serverViewModel.steps;

  const client = useMemo(
    () =>
      createOnboardingApiClient({
        ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
        getAccessToken: readWorkBuddyAccessToken,
        onAuthenticationExpired: clearWorkBuddyAccessToken,
        origin: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
      }),
    [apiBaseUrl],
  );

  const updateField = <K extends keyof OnboardingFormValues>(
    field: K,
    value: OnboardingFormValues[K],
  ) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    dispatch({ type: 'edit' });
  };

  const acceptStartResult = (result: OnboardingStartResult) => {
    if (result.action === 'continue_onboarding') {
      dispatch({ type: 'server_succeeded', result });
    } else {
      setExistingManagement(result);
      dispatch({ type: 'existing_assistant' });
    }
  };

  const checkExistingOrResume = async () => {
    if (!canWrite) return;
    dispatch({ type: 'request_started', operation: 'save' });
    try {
      acceptStartResult(await client.startOrResume({ idempotencyKey: createIdempotencyKey() }));
    } catch (error) {
      dispatch({
        type: 'request_failed',
        error:
          error instanceof OnboardingClientError
            ? error
            : new OnboardingClientError('request_failed', '无法确认已有客服或引导进度。'),
      });
    }
  };

  const goToNextStep = () => {
    const nextErrors = validateOnboardingStep(currentStep, values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const nextStep = formSteps[stepIndex[currentStep] + 1];
    if (nextStep !== undefined) {
      setCurrentStep(nextStep);
      dispatch({ type: 'edit', notice: '本步骤已在浏览器内校验，尚未保存到服务端。' });
    }
  };

  const goToPreviousStep = () => {
    const previousStep = formSteps[stepIndex[currentStep] - 1];
    if (previousStep !== undefined) setCurrentStep(previousStep);
  };

  const submitToServer = async () => {
    const nextErrors = validateAllOnboardingSteps(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !canWrite) return;

    dispatch({ type: 'request_started', operation: 'save' });
    try {
      const result = await submitCompleteOnboarding({ client, createIdempotencyKey, values });
      acceptStartResult(result);
    } catch (error) {
      dispatch({
        type: 'request_failed',
        error:
          error instanceof OnboardingClientError
            ? error
            : new OnboardingClientError('request_failed', '请求未完成，服务端未确认保存。'),
      });
    }
  };

  const changePauseState = async (event: { type: 'cancel' } | { type: 'resume' }) => {
    const result = interaction.result;
    if (!canWrite || result === undefined) return;
    dispatch({ type: 'request_started', operation: event.type === 'cancel' ? 'pause' : 'resume' });
    try {
      const updated = await client.advance({
        event,
        idempotencyKey: createIdempotencyKey(),
        sessionId: result.onboarding_session_id,
      });
      dispatch({ type: 'server_succeeded', result: updated });
    } catch (error) {
      dispatch({
        type: 'request_failed',
        error:
          error instanceof OnboardingClientError
            ? error
            : new OnboardingClientError('request_failed', '操作未完成，服务端未确认状态。'),
      });
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (currentStep === 'confirmation') void submitToServer();
    else goToNextStep();
  };

  return (
    <>
      <section aria-labelledby="progress-heading" className="onboarding-progress">
        <div className="section-title-row">
          <div>
            <p className="panel__eyebrow">引导进度</p>
            <h2 id="progress-heading">四步准备客服草稿</h2>
          </div>
          <StatusBadge tone={statusTone(interaction.status)}>
            {statusLabels[interaction.status] ?? interaction.status}
          </StatusBadge>
        </div>
        <ProgressSteps ariaLabel="AI 客服生成进度" steps={displaySteps} />
        <p className="local-progress-note">进度在服务端确认前仅代表本页填写位置。</p>
        <Button
          disabled={!canWrite}
          onClick={() => void checkExistingOrResume()}
          variant="secondary"
        >
          检查已有客服或恢复进度
        </Button>
      </section>

      {existingManagement ? (
        <section className="onboarding-step-card" role="status">
          <h2>已找到这个商家的 AI 客服</h2>
          <p>
            {existingManagement.action === 'select_assistant'
              ? `当前有 ${existingManagement.assistants.length} 个客服，请在后台明确选择。`
              : '无需再次生成。请在现有后台核对资料、管理知识和发布版本。'}
          </p>
          <a href={existingManagement.url}>打开商家管理后台</a>
        </section>
      ) : null}

      <div className="onboarding-layout">
        <form aria-describedby="submission-notice" className="onboarding-form" onSubmit={onSubmit}>
          <div
            className={`submission-notice submission-notice--${statusTone(interaction.status)}`}
            id="submission-notice"
            role="status"
          >
            <strong>{interaction.notice}</strong>
            {!apiConfigured ? <span>管理 API 未配置，网络写入已禁用。</span> : null}
            {apiConfigured && !authorized ? <span>尚未安全绑定，网络写入已禁用。</span> : null}
            {interaction.requestId ? <small>请求编号：{interaction.requestId}</small> : null}
          </div>

          {currentStep === 'industry' ? (
            <section aria-labelledby="industry-step-heading" className="onboarding-step-card">
              <StepHeader
                id="industry-step-heading"
                number="01"
                eyebrow="行业"
                title="先确定业务所在领域"
              />
              <div className="form-grid">
                <label className="form-grid__wide">
                  所属行业
                  <input
                    aria-describedby="industry-error"
                    disabled={busy}
                    list="industry-suggestions"
                    onChange={(event) => updateField('industryCode', event.target.value)}
                    placeholder="例如：家电清洗、零售、教育服务"
                    value={values.industryCode}
                  />
                  <datalist id="industry-suggestions">
                    <option value="家政与本地生活" />
                    <option value="零售与商品销售" />
                    <option value="教育与专业服务" />
                  </datalist>
                  <FieldError error={errors.industryCode} id="industry-error" />
                </label>
              </div>
            </section>
          ) : null}

          {currentStep === 'materials' ? (
            <section aria-labelledby="materials-step-heading" className="onboarding-step-card">
              <StepHeader
                id="materials-step-heading"
                number="02"
                eyebrow="产品 / 商品 / 服务资料"
                title="只提交可以确认的真实信息"
              />
              <div className="form-grid">
                <TextField
                  busy={busy}
                  error={errors.businessName}
                  label="商家或业务名称"
                  onChange={(value) => updateField('businessName', value)}
                  value={values.businessName}
                />
                <label>
                  类型
                  <select
                    disabled={busy}
                    onChange={(event) =>
                      updateField(
                        'offeringKind',
                        event.target.value as OnboardingFormValues['offeringKind'],
                      )
                    }
                    value={values.offeringKind}
                  >
                    <option value="product">产品</option>
                    <option value="goods">商品</option>
                    <option value="service">服务</option>
                  </select>
                </label>
                <TextAreaField
                  busy={busy}
                  error={errors.businessDescription}
                  label="业务范围与服务对象"
                  onChange={(value) => updateField('businessDescription', value)}
                  value={values.businessDescription}
                />
                <TextField
                  busy={busy}
                  error={errors.offeringName}
                  label="产品、商品或服务名称"
                  onChange={(value) => updateField('offeringName', value)}
                  value={values.offeringName}
                />
                <TextField
                  busy={busy}
                  error={errors.offeringTargetAudience}
                  label="适用对象"
                  onChange={(value) => updateField('offeringTargetAudience', value)}
                  value={values.offeringTargetAudience}
                />
                <TextAreaField
                  busy={busy}
                  error={errors.offeringDescription}
                  label="具体内容"
                  onChange={(value) => updateField('offeringDescription', value)}
                  value={values.offeringDescription}
                />
                <label>
                  资料类型
                  <select
                    disabled={busy}
                    onChange={(event) =>
                      updateField(
                        'materialKind',
                        event.target.value as OnboardingFormValues['materialKind'],
                      )
                    }
                    value={values.materialKind}
                  >
                    <option value="faq">FAQ</option>
                    <option value="text">文本</option>
                    <option value="pdf">PDF</option>
                    <option value="other">其他</option>
                  </select>
                </label>
                <TextField
                  busy={busy}
                  error={errors.materialReference}
                  label="资料名称或引用"
                  onChange={(value) => updateField('materialReference', value)}
                  value={values.materialReference}
                />
                <TextAreaField
                  busy={busy}
                  error={errors.materialSummary}
                  label="资料摘要"
                  onChange={(value) => updateField('materialSummary', value)}
                  value={values.materialSummary}
                />
              </div>
            </section>
          ) : null}

          {currentStep === 'policy' ? (
            <section aria-labelledby="policy-step-heading" className="onboarding-step-card">
              <StepHeader
                id="policy-step-heading"
                number="03"
                eyebrow="价格 / 优惠 / 售卖策略"
                title="为关键事实设置清晰边界"
              />
              <div className="form-grid">
                <PolicySelect
                  busy={busy}
                  error={errors.pricingAvailability}
                  label="价格资料状态"
                  onChange={(value) => updateField('pricingAvailability', value)}
                  value={values.pricingAvailability}
                />
                <PolicySelect
                  busy={busy}
                  error={errors.promotionAvailability}
                  label="优惠资料状态"
                  onChange={(value) => updateField('promotionAvailability', value)}
                  value={values.promotionAvailability}
                />
                {values.pricingAvailability === 'provided' ? (
                  <>
                    <TextField
                      busy={busy}
                      error={errors.priceAmount}
                      label="价格金额"
                      onChange={(value) => updateField('priceAmount', value)}
                      value={values.priceAmount}
                    />
                    <TextField
                      busy={busy}
                      error={errors.priceCurrency}
                      label="币种"
                      onChange={(value) => updateField('priceCurrency', value.toUpperCase())}
                      value={values.priceCurrency}
                    />
                    <TextField
                      busy={busy}
                      label="价格适用条件"
                      onChange={(value) => updateField('priceConditions', value)}
                      value={values.priceConditions}
                    />
                  </>
                ) : null}
                {values.promotionAvailability === 'provided' ? (
                  <>
                    <TextField
                      busy={busy}
                      error={errors.promotionName}
                      label="优惠名称"
                      onChange={(value) => updateField('promotionName', value)}
                      value={values.promotionName}
                    />
                    <TextField
                      busy={busy}
                      error={errors.promotionDescription}
                      label="优惠说明"
                      onChange={(value) => updateField('promotionDescription', value)}
                      value={values.promotionDescription}
                    />
                    <TextField
                      busy={busy}
                      label="优惠条件"
                      onChange={(value) => updateField('promotionConditions', value)}
                      value={values.promotionConditions}
                    />
                  </>
                ) : null}
                <label className="form-grid__wide">
                  资料不足时
                  <select
                    disabled={busy}
                    onChange={(event) =>
                      updateField(
                        'insufficientFactPolicy',
                        event.target.value as OnboardingFormValues['insufficientFactPolicy'],
                      )
                    }
                    value={values.insufficientFactPolicy}
                  >
                    <option value="">请选择</option>
                    <option value="say_unconfirmed">明确说明无法确认</option>
                    <option value="collect_lead">收集需求供商家跟进</option>
                    <option value="contact_merchant">引导联系商家</option>
                  </select>
                  <FieldError error={errors.insufficientFactPolicy} id="insufficient-error" />
                </label>
              </div>
            </section>
          ) : null}

          {currentStep === 'confirmation' ? (
            <section aria-labelledby="confirm-step-heading" className="onboarding-step-card">
              <StepHeader
                id="confirm-step-heading"
                number="04"
                eyebrow="确认生成"
                title="复核资料，再交给服务端生成"
              />
              <dl className="confirmation-summary">
                <div>
                  <dt>行业</dt>
                  <dd>{values.industryCode}</dd>
                </div>
                <div>
                  <dt>业务</dt>
                  <dd>{values.businessName}</dd>
                </div>
                <div>
                  <dt>提供内容</dt>
                  <dd>{values.offeringName}</dd>
                </div>
                <div>
                  <dt>资料</dt>
                  <dd>{values.materialReference}</dd>
                </div>
              </dl>
              <div className="confirmation-note">
                <p>
                  生成结果是可编辑草稿，不会自动发布。只有服务端返回成功后才会显示已保存或生成完成。
                </p>
                <label>
                  <input
                    checked={values.merchantConfirmed}
                    disabled={busy}
                    onChange={(event) => updateField('merchantConfirmed', event.target.checked)}
                    type="checkbox"
                  />
                  <span>我已核对以上资料，并理解生成后仍需测试和发布。</span>
                </label>
                <FieldError error={errors.merchantConfirmed} id="confirmation-error" />
              </div>
            </section>
          ) : null}

          <div className="onboarding-actions">
            <div>
              <Button
                disabled={currentStep === 'industry' || busy}
                onClick={goToPreviousStep}
                variant="ghost"
              >
                上一步
              </Button>
              <Button
                disabled={!serverViewModel.canCancel || busy}
                onClick={() => void changePauseState({ type: 'cancel' })}
                variant="ghost"
              >
                暂停引导
              </Button>
              <Button
                disabled={!serverViewModel.canResume || busy}
                onClick={() => void changePauseState({ type: 'resume' })}
                variant="secondary"
              >
                恢复引导
              </Button>
            </div>
            {currentStep === 'confirmation' ? (
              <Button disabled={!canWrite || !values.merchantConfirmed || busy} type="submit">
                {existingManagement
                  ? '请使用已有客服后台'
                  : busy
                    ? '等待服务端确认'
                    : '确认并由服务端生成'}
              </Button>
            ) : (
              <Button disabled={busy} type="submit">
                检查并继续
              </Button>
            )}
          </div>
        </form>

        <aside className="onboarding-aside">
          <section className="missing-panel">
            <p className="panel__eyebrow">安全边界</p>
            <h2>提交条件</h2>
            <ul className="requirements-list">
              <li data-ready={apiConfigured}>同源管理 API 已配置</li>
              <li data-ready={authorized}>WorkBuddy 已安全绑定</li>
              <li data-ready={interaction.result !== undefined}>服务端 onboarding 会话已建立</li>
            </ul>
          </section>
          <section className="help-panel" id="help">
            <p className="panel__eyebrow">帮助</p>
            <h2>填写与恢复</h2>
            <details>
              <summary>页面刷新后会恢复吗？</summary>
              <p>本页不把资料写入 localStorage。只有服务端确认保存的会话才能在重新授权后恢复。</p>
            </details>
            <details>
              <summary>发生版本冲突怎么办？</summary>
              <p>停止覆盖并提示刷新服务端最新状态；页面不会静默覆盖另一处修改。</p>
            </details>
            <details>
              <summary>生成后会直接上线吗？</summary>
              <p>不会。服务端生成的是草稿，仍需测试并明确发布。</p>
            </details>
          </section>
        </aside>
      </div>
    </>
  );
}

function StepHeader({
  eyebrow,
  id,
  number,
  title,
}: {
  eyebrow: string;
  id: string;
  number: string;
  title: string;
}) {
  return (
    <div className="onboarding-step-card__header">
      <span aria-hidden="true" className="onboarding-step-card__number">
        {number}
      </span>
      <div>
        <p>{eyebrow}</p>
        <h2 id={id}>{title}</h2>
      </div>
    </div>
  );
}

function TextField({
  busy,
  error,
  label,
  onChange,
  value,
}: {
  busy: boolean;
  error?: string | undefined;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const id = `${label.replace(/\s/gu, '-')}-error`;
  return (
    <label>
      {label}
      <input
        aria-describedby={error ? id : undefined}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
      <FieldError error={error} id={id} />
    </label>
  );
}

function TextAreaField({
  busy,
  error,
  label,
  onChange,
  value,
}: {
  busy: boolean;
  error?: string | undefined;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const id = `${label.replace(/\s/gu, '-')}-error`;
  return (
    <label className="form-grid__wide">
      {label}
      <textarea
        aria-describedby={error ? id : undefined}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        value={value}
      />
      <FieldError error={error} id={id} />
    </label>
  );
}

function PolicySelect({
  busy,
  error,
  label,
  onChange,
  value,
}: {
  busy: boolean;
  error?: string | undefined;
  label: string;
  onChange: (value: OnboardingFormValues['pricingAvailability']) => void;
  value: OnboardingFormValues['pricingAvailability'];
}) {
  const id = `${label}-error`;
  return (
    <label>
      {label}
      <select
        aria-describedby={error ? id : undefined}
        disabled={busy}
        onChange={(event) =>
          onChange(event.target.value as OnboardingFormValues['pricingAvailability'])
        }
        value={value}
      >
        <option value="">请选择</option>
        <option value="provided">已提供并确认</option>
        <option value="none_confirmed">确认无此类信息</option>
        <option value="unknown">需要人工确认</option>
      </select>
      <FieldError error={error} id={id} />
    </label>
  );
}
