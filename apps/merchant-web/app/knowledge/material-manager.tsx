'use client';
import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { KnowledgeMaterial } from '@h5cs/database';
import { merchantPath } from '../tenant-paths';
export function MaterialManager({
  merchantId,
  assistantId,
  csrfToken,
  revision,
  materials,
}: {
  merchantId: string;
  assistantId: string;
  csrfToken: string;
  revision: number;
  materials: readonly KnowledgeMaterial[] | null;
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
  const endpoint = `${merchantPath(merchantId, 'knowledge', assistantId)}/materials`;
  async function request(kind: string, body: FormData | Record<string, unknown>) {
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
      };
      if (!response.ok || result.error)
        throw new Error(
          [result.error ?? '操作未完成，请稍后重试。', ...(result.errors ?? [])].join('\n'),
        );
      if (kind === 'upload') {
        const ids = Array.isArray(result.saved) ? result.saved : [];
        setSelected(ids);
        setNotice(`已保存 ${ids.length} 份可解析材料，尚未加入客服知识。`);
        setError(result.errors?.join('\n') ?? '');
        if (fileInput.current) fileInput.current.value = '';
        router.refresh();
      } else if (kind === 'organize') {
        setSummary(result.summary ?? '');
        setWarnings(result.warnings ?? []);
        setConfirmed(false);
        setNotice('已生成待核对整理稿，尚未保存或发布。');
      } else {
        setSummary('');
        setWarnings([]);
        setConfirmed(false);
        setNotice('已保存到新的草稿修订。请重新确认资料、试聊并发布，消费者才会使用新版知识。');
        router.refresh();
      }
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== 'TimeoutError' && cause.name !== 'TypeError'
          ? cause.message
          : '网络中断或处理超时，请刷新核对已保存材料／草稿后再操作。',
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="merchant-account-card assistant-detail-card" aria-label="基础材料管理">
      <h2>上传基础材料并整理为知识</h2>
      <p>
        支持 PDF、DOC/DOCX、PPT/PPTX、XLS/XLSX、TXT、CSV、Markdown。每次最多 5 份，单份 10 MB、合计
        20 MB。只提取文字，不执行宏、链接或公式；扫描件暂不支持
        OCR。原文件不长期保存，仅保存提取文字、文件名和摘要指纹。
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? (
        <p role="alert" className="knowledge-error">
          {error}
        </p>
      ) : null}
      <form
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
            disabled={!!busy}
          />
        </label>
        <button type="submit" disabled={!!busy || materials === null}>
          {busy === 'upload' ? '正在解析并保存…' : '上传并提取文字'}
        </button>
      </form>
      {materials === null ? (
        <p role="alert">材料库暂不可用，请刷新重试。</p>
      ) : materials.length ? (
        <>
          <h3>已保存材料</h3>
          <p>每个客服最多保存 50 份材料。展开可检查原始提取文字；所选文字合计最多 24000 字。</p>
          {materials.map((item) => (
            <div className="knowledge-material" key={item.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  disabled={!!busy}
                  onChange={(event) => {
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, item.id]
                        : previous.filter((id) => id !== item.id),
                    );
                    setConfirmed(false);
                  }}
                />
                {item.name}（{item.text.length} 字）
              </label>
              <details>
                <summary>查看提取文字</summary>
                <pre>{item.text}</pre>
              </details>
            </div>
          ))}
          <label className="knowledge-consent">
            <input
              type="checkbox"
              checked={consent}
              disabled={!!busy}
              onChange={(event) => setConsent(event.target.checked)}
            />
            我同意将所选材料的文字发送至阿里云千问整理，已检查其中不含不应发送的个人或机密资料。
          </label>
          <button
            disabled={!!busy || !consent || !selected.length || selected.length > 5}
            type="button"
            onClick={() => void request('organize', { sourceIds: selected, consent })}
          >
            {busy === 'organize' ? '正在整理…' : 'AI 整理所选材料'}
          </button>
          <button
            disabled={!!busy || !selected.length}
            type="button"
            onClick={() => {
              const text = materials
                .filter((item) => selected.includes(item.id))
                .map((item) => `【来源：${item.name}】\n${item.text}`)
                .join('\n\n');
              if (text.length > 4000) {
                setError('提取文字超过 4000 字，请先 AI 整理，或自行复制精简后填写整理稿。');
                return;
              }
              setSummary(text);
              setWarnings([]);
              setConfirmed(false);
            }}
          >
            直接使用提取文字
          </button>
        </>
      ) : (
        <p>尚无上传材料。可上传商品表、服务说明、售后规则或 FAQ。</p>
      )}
      <form
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
            rows={12}
            value={summary}
            maxLength={4000}
            required
            disabled={!!busy}
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
            disabled={!!busy}
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
            disabled={!!busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我已核对整理稿与现有价格、优惠及适用条件，确认按所选方式保存；不会自动发布
        </label>
        <button type="submit" disabled={!!busy || !confirmed || !summary.trim()}>
          {busy === 'apply' ? '正在保存…' : '保存整理稿到客服草稿'}
        </button>
      </form>
    </section>
  );
}
