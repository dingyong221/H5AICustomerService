'use client';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { KnowledgeMaterial } from '@h5cs/database';
import { merchantPath } from '../tenant-paths';
import { useUnsavedForm } from '../workspace/use-unsaved-form';
import {
  filterMaterials,
  knowledgeTemplates,
  materialKinds,
  reviewMaterials,
  type MaterialKind,
} from './material-review';
export function MaterialManager({
  merchantId,
  assistantId,
  csrfToken,
  revision,
  materials,
  effectiveCharacters = 0,
  hasPublishedVersion = false,
}: {
  merchantId: string;
  assistantId: string;
  csrfToken: string;
  revision: number;
  materials: readonly KnowledgeMaterial[] | null;
  effectiveCharacters?: number;
  hasPublishedVersion?: boolean;
}) {
  const router = useRouter(),
    fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string[]>([]),
    [summary, setSummary] = useState(''),
    [warnings, setWarnings] = useState<readonly string[]>([]);
  const [consent, setConsent] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [mode, setMode] = useState('append');
  const [busy, setBusy] = useState<string | null>(null),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null),
    [deletedIds, setDeletedIds] = useState<string[]>([]);
  const previousMaterials = useRef(materials);
  const visibleMaterials = materials?.filter((item) => !deletedIds.includes(item.id));
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MaterialKind>('all');
  const [templateId, setTemplateId] = useState<string>('product');
  const [stage, setStage] = useState<'materials' | 'review'>('materials');
  const advanceAfterSave = useRef(false);
  const shownMaterials = filterMaterials(visibleMaterials ?? [], query, kind);
  const reminders = reviewMaterials(visibleMaterials ?? []);
  const disabled = !!busy || pendingDelete !== null || materials === null;
  const permitNavigation = useUnsavedForm(!!summary.trim() || busy !== null);
  function clearOrganization() {
    setSummary('');
    setWarnings([]);
    setConfirmed(false);
    setConsent(false);
  }
  useEffect(() => {
    if (materials !== null && previousMaterials.current !== null) {
      const active = new Set(materials.map((item) => item.id));
      const removed = new Set(
        previousMaterials.current
          // A verified local deletion already invalidated its old summary. A
          // delayed RSC acknowledgment must not clear a newer summary written
          // from the remaining materials after that successful deletion.
          .filter((item) => !active.has(item.id) && !deletedIds.includes(item.id))
          .map((item) => item.id),
      );
      if (removed.size) {
        setSelected((previous) => previous.filter((source) => !removed.has(source)));
        setSummary('');
        setWarnings([]);
        setConfirmed(false);
        setConsent(false);
        setPendingDelete(null);
      }
    }
    if (materials !== null) previousMaterials.current = materials;
  }, [materials, deletedIds]);
  const endpoint = `${merchantPath(merchantId, 'knowledge', assistantId)}/materials`;
  async function request(kind: string, body: FormData | Record<string, unknown>) {
    if (
      kind === 'organize' &&
      summary.trim() &&
      !window.confirm('重新整理将替换当前未保存的整理稿。确认继续？')
    )
      return;
    setBusy(kind);
    setError('');
    setNotice('');
    try {
      const response = await fetch(endpoint + (kind === 'upload' ? '' : `/${kind}`), {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          'x-h5cs-csrf': csrfToken,
          ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(kind === 'upload' ? 120000 : 30000),
      });
      const result = (await response.json()) as {
        error?: string;
        saved?: string[] | boolean;
        errors?: string[];
        summary?: string;
        warnings?: string[];
        deleted?: boolean;
        sourceId?: string;
        reused?: string[];
      };
      if (!response.ok || result.error)
        throw new Error(
          [result.error ?? '操作未完成，请稍后重试。', ...(result.errors ?? [])].join('\n'),
        );
      if (kind === 'upload') {
        const ids = Array.isArray(result.saved) ? result.saved : [];
        if (!ids.length || !ids.every((id) => typeof id === 'string' && /^[0-9a-f]{32}$/u.test(id)))
          throw new Error('未能确认上传结果，请刷新核对已保存材料后再操作；不会自动重试。');
        setSelected(ids);
        setConfirmed(false);
        setConsent(false);
        const reused = Array.isArray(result.reused)
          ? result.reused.filter((id) => ids.includes(id))
          : [];
        setNotice(
          `已保存 ${ids.length} 份可解析材料，${reused.length ? `其中 ${reused.length} 份原文相同，已复用已有材料而非重复保存；` : ''}尚未加入客服知识。${summary.trim() ? '原有未保存整理稿已保留，新增材料不会自动追加；请重新整理或手动补充后核对保存。' : ''}`,
        );
        setError(result.errors?.join('\n') ?? '');
        if (fileInput.current) fileInput.current.value = '';
        router.refresh();
      } else if (kind === 'organize') {
        setSummary(result.summary ?? '');
        setWarnings(result.warnings ?? []);
        setConfirmed(false);
        setNotice('已生成待核对整理稿，尚未保存或发布。');
        setStage('review');
      } else if (kind === 'delete') {
        const sourceId = body instanceof FormData ? null : body.sourceId;
        if (result.deleted !== true || result.sourceId !== sourceId || typeof sourceId !== 'string')
          throw new Error('未能确认删除结果，请刷新核对已保存材料后再操作；不会自动重试。');
        setDeletedIds((previous) => [...previous, sourceId]);
        setSelected((previous) => previous.filter((id) => id !== sourceId));
        clearOrganization();
        setPendingDelete(null);
        setNotice(
          '材料已删除，未保存的整理稿已清空。已保存草稿、已发布客服及消费者链接未改变；如需撤下相关回答，请修改草稿并重新发布。',
        );
        router.refresh();
      } else if (kind === 'apply') {
        if (result.saved !== true)
          throw new Error(
            '未能确认保存结果，整理稿已保留。请刷新核对草稿修订后再操作；不会自动重试。',
          );
        clearOrganization();
        setNotice('知识已保存到草稿。下一步进入效果试聊，发布后才会更新消费者回答。');
        if (advanceAfterSave.current) {
          permitNavigation();
          router.push(merchantPath(merchantId, 'preview', assistantId));
        } else {
          router.refresh();
        }
      } else {
        throw new Error('未能确认操作类型，请刷新核对后再操作。');
      }
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== 'TimeoutError' && cause.name !== 'TypeError'
          ? cause.message
          : '网络中断或处理超时，请刷新核对已保存材料／草稿后再操作。',
      );
    } finally {
      setBusy(null);
      advanceAfterSave.current = false;
    }
  }
  return (
    <section
      className="merchant-account-card assistant-detail-card knowledge-manager"
      aria-label="基础材料管理"
    >
      <h2>上传并补充知识</h2>
      <p>上传 → 整理 → 核对保存。已有完整资料时，可直接进入下一步试聊。</p>
      <div className="knowledge-coverage" aria-label="知识生效范围">
        <span>
          已上传：{materials === null ? '读取失败' : `${visibleMaterials?.length ?? 0} 份`}
        </span>
        <span>草稿有效资料：{effectiveCharacters} / 4000 字</span>
        <span>{hasPublishedVersion ? '已有线上版本，草稿修改尚需试聊并发布' : '尚无线上版本'}</span>
        <p>
          上传不等于生效。只有保存进草稿并经试聊判定后发布的文字参与回答；不能据此认为每份附件全部被使用。
        </p>
      </div>
      <div className="knowledge-stage-switch" role="group" aria-label="知识补充操作区">
        <button
          type="button"
          aria-pressed={stage === 'materials'}
          onClick={() => setStage('materials')}
        >
          1. 选择与整理材料
        </button>
        <button type="button" aria-pressed={stage === 'review'} onClick={() => setStage('review')}>
          2. 核对并保存{summary.trim() ? ' · 有待保存内容' : ''}
        </button>
      </div>
      <details className="knowledge-format-help">
        <summary>支持的格式与上传说明</summary>
        <p>
          PDF、DOC/DOCX、PPT/PPTX、XLS/XLSX、TXT、CSV、Markdown。每次最多 5 份，单份 10 MB、合计 20
          MB。只提取文字，不执行宏、链接或公式；扫描件暂不支持
          OCR。原文件不长期保存，仅保存提取文字、文件名和摘要指纹。
        </p>
      </details>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? (
        <p role="alert" className="knowledge-error">
          {error}
        </p>
      ) : null}
      <div hidden={stage !== 'materials'}>
        <form
          data-usage="knowledge.upload"
          className="merchant-account-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void request('upload', form);
          }}
        >
          <label>
            选择基础材料
            <input
              ref={fileInput}
              type="file"
              name="files"
              multiple
              required
              accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv,.md"
              disabled={disabled}
            />
          </label>
          <button type="submit" disabled={disabled || materials === null}>
            {busy === 'upload' ? '正在解析并保存…' : '上传并提取文字'}
          </button>
        </form>
        {materials === null ? (
          <p role="alert">材料库暂不可用，请刷新重试。</p>
        ) : visibleMaterials?.length ? (
          <>
            <h3>已保存材料</h3>
            <p>每个客服最多保存 50 份材料。展开可检查原始提取文字；所选文字合计最多 24000 字。</p>
            <div className="knowledge-maintenance-tools">
              <label>
                查找材料或文字
                <input
                  type="search"
                  value={query}
                  maxLength={200}
                  placeholder="例如：商品名、运费、营业时间"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label>
                按文件格式
                <select
                  value={kind}
                  onChange={(event) => {
                    if (materialKinds.includes(event.target.value as MaterialKind))
                      setKind(event.target.value as MaterialKind);
                  }}
                >
                  <option value="all">全部格式</option>
                  <option value="document">文档 / PDF / 演示文稿</option>
                  <option value="table">表格 / CSV</option>
                  <option value="text">文字 / Markdown</option>
                </select>
              </label>
              <p aria-live="polite">
                显示 {shownMaterials.length} / {visibleMaterials.length} 份 · 已选 {selected.length}{' '}
                份；筛选不会清除已选材料。
              </p>
              <button
                type="button"
                disabled={disabled || !shownMaterials.length}
                onClick={() => {
                  setSelected(shownMaterials.slice(0, 5).map((item) => item.id));
                  setConfirmed(false);
                  setConsent(false);
                  setNotice('已选择当前结果的前 5 份以内材料；更多材料请分批整理。');
                }}
              >
                选择当前结果（最多5份）
              </button>
              <button
                type="button"
                disabled={disabled || !selected.length}
                onClick={() => {
                  setSelected([]);
                  setConfirmed(false);
                  setConsent(false);
                }}
              >
                清空选择
              </button>
            </div>
            <details className="knowledge-review-reminders">
              <summary>材料核对提醒：{reminders.length} 项</summary>
              <p>
                仅检查完全重复、明确问答同题不同答和标明的截止日期。不能识别所有语义冲突、缺失或过期内容；没有提醒也不等于资料正确。请对照单独价格与优惠字段核对，不会自动合并、删改或下架。
              </p>
              {reminders.length ? (
                <ul>
                  {reminders.slice(0, 10).map((item, index) => (
                    <li key={index}>{item.detail}</li>
                  ))}
                </ul>
              ) : (
                <p>本轮规则检查未发现上述提醒，请仍自行核对真实商品与适用条件。</p>
              )}
              {reminders.length > 10 ? <p>共 {reminders.length} 项，先展示前 10 项。</p> : null}
            </details>
            {!shownMaterials.length ? (
              <p aria-live="polite">没有找到匹配材料，请调整关键词或文件格式。</p>
            ) : null}
            <div
              className="knowledge-material-list"
              role="region"
              aria-label="可选择的已上传材料"
              tabIndex={0}
            >
              {shownMaterials.map((item) => (
                <div className="knowledge-material" key={item.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      disabled={disabled}
                      onChange={(event) => {
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, item.id]
                            : previous.filter((id) => id !== item.id),
                        );
                        setConfirmed(false);
                        setConsent(false);
                      }}
                    />
                    {item.name}（{item.text.length} 字）
                  </label>
                  <details>
                    <summary>查看提取文字</summary>
                    <pre>{item.text}</pre>
                  </details>
                  <small>
                    录入于{' '}
                    {new Date(item.createdAt).toLocaleDateString('zh-CN', {
                      timeZone: 'Asia/Shanghai',
                    })}{' '}
                    · 只保存提取文字，原文件请自行保留
                  </small>
                  <button
                    type="button"
                    aria-label={`删除材料：${item.name}`}
                    disabled={disabled}
                    onClick={() => setPendingDelete(item.id)}
                  >
                    删除材料
                  </button>
                  {pendingDelete === item.id ? (
                    <div role="alertdialog" aria-label={`删除材料：${item.name}`}>
                      <p>
                        确认删除“{item.name}
                        ”？删除后将不能再选用或整理这份材料，未保存的整理稿也会清空。
                      </p>
                      <p>
                        仅从材料库移除，不会自动修改已保存草稿、已发布客服或消费者链接。若需撤下相关回答，请修改草稿并重新发布。
                      </p>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() =>
                          void request('delete', { sourceId: item.id, confirmed: true })
                        }
                      >
                        {busy === 'delete' ? '正在删除…' : '确认删除材料'}
                      </button>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => setPendingDelete(null)}
                      >
                        取消
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <label className="knowledge-consent">
              <input
                type="checkbox"
                checked={consent}
                disabled={disabled}
                onChange={(event) => setConsent(event.target.checked)}
              />
              我同意将所选材料的文字发送至阿里云千问整理，已检查其中不含不应发送的个人或机密资料。
            </label>
            <p>
              AI
              可能遗漏或误解原文。请对照提取文字检查价格、适用条件和冲突事项；生成成功不等于资料已确认。
            </p>
            <button
              data-usage="knowledge.organize"
              disabled={disabled || !consent || !selected.length || selected.length > 5}
              type="button"
              onClick={() => void request('organize', { sourceIds: selected, consent })}
            >
              {busy === 'organize' ? '正在整理…' : 'AI 整理所选材料'}
            </button>
            <button
              disabled={disabled || !selected.length}
              type="button"
              onClick={() => {
                const text = visibleMaterials
                  .filter((item) => selected.includes(item.id))
                  .map((item) => `【来源：${item.name}】\n${item.text}`)
                  .join('\n\n');
                if (text.length > 4000) {
                  setError('提取文字超过 4000 字，请先 AI 整理，或自行复制精简后填写整理稿。');
                  return;
                }
                if (
                  summary.trim() &&
                  summary !== text &&
                  !window.confirm('使用提取文字将替换当前未保存的整理稿。确认继续？')
                )
                  return;
                setSummary(text);
                setWarnings([]);
                setConfirmed(false);
                setStage('review');
              }}
            >
              直接使用提取文字
            </button>
          </>
        ) : (
          <p>尚无上传材料。可上传商品表、服务说明、售后规则或 FAQ。</p>
        )}
        <details className="knowledge-quick-entry">
          <summary>不会写？从业务填空模板开始</summary>
          <p>
            插入到下方整理稿后，填写真实信息再核对保存。“待补充”不能当作已确认业务事实；模板不会自动保存或发布。
          </p>
          <label>
            选择业务模板
            <select
              value={templateId}
              disabled={disabled}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              {knowledgeTemplates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              const template = knowledgeTemplates.find((item) => item.id === templateId);
              if (!template) return;
              const next = [summary.trim(), template.text].filter(Boolean).join('\n\n');
              if (next.length > 4000) {
                setError('插入模板后超过4000字，请先精简现有整理稿；原文未改。');
                return;
              }
              setSummary(next);
              setConfirmed(false);
              setConsent(false);
              setNotice('已插入填空模板，请补充真实内容并核对；原有整理稿已保留，尚未保存或发布。');
              setStage('review');
            }}
          >
            插入到整理稿
          </button>
        </details>
        <button type="button" className="knowledge-manual-entry" onClick={() => setStage('review')}>
          没有文件？直接补充文字并继续
        </button>
      </div>
      <div hidden={stage !== 'review'}>
        <section className="knowledge-summary-editor" aria-label="核对并保存知识整理稿">
          <form
            data-usage="knowledge.save"
            className="merchant-account-form"
            onSubmit={(event) => {
              event.preventDefault();
              void request('apply', { summary, revision, mode, confirmed });
            }}
          >
            <h3>核对并保存知识整理稿</h3>
            <p>
              整理稿最多 4000
              字。只有下方保存后的内容会写入“商品或服务资料”；完整原文件不会自动成为客服回答依据。价格与优惠原字段不会自动改写，请同步核对避免冲突。
            </p>
            <label>
              知识整理稿
              <textarea
                aria-label="知识整理稿"
                rows={7}
                value={summary}
                maxLength={4000}
                required
                disabled={disabled}
                onChange={(event) => {
                  setSummary(event.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
            <p>
              {summary.length} / 4000 字 · 当前草稿修订 {revision}
            </p>
            {warnings.length ? (
              <ul>
                {warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <label>
              保存方式
              <select
                value={mode}
                disabled={disabled}
                onChange={(event) => {
                  setMode(event.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="append">追加到现有商品或服务资料</option>
                <option value="replace">替换现有商品或服务资料（需核对原文）</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                required
                disabled={disabled}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我已核对整理稿与现有价格、优惠及适用条件，确认按所选方式保存；不会自动发布
            </label>
            <button type="submit" disabled={disabled || !confirmed || !summary.trim()}>
              {busy === 'apply' ? '正在保存…' : '保存整理稿到客服草稿'}
            </button>
            <button
              type="submit"
              disabled={disabled || !confirmed || !summary.trim()}
              onClick={() => {
                advanceAfterSave.current = true;
              }}
            >
              {busy === 'apply' ? '正在保存…' : '保存并进入效果试聊'}
            </button>
          </form>
        </section>
      </div>
    </section>
  );
}
