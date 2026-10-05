'use client';

import { useState } from 'react';
import { parseWritingResult, writingFields, type WritingField } from '@h5cs/contracts';

export function WritingAssistant({
  merchantId,
  csrfToken,
  field,
  currentText = '',
  onApply,
}: {
  merchantId: string;
  csrfToken: string;
  field: WritingField;
  currentText?: string;
  onApply?: (text: string) => void;
}) {
  const [brief, setBrief] = useState('');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [reminders, setReminders] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function generate() {
    if (pending) return;
    if (!brief.trim() || !consent) {
      setError('请先填写简述，并勾选发送文字至千问的确认。');
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/${merchantId}/writing/generate`, {
        method: 'POST',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', 'x-h5cs-csrf': csrfToken },
        body: JSON.stringify({ field, brief, currentText, consent }),
      });
      const payload = await response.json();
      const result = response.ok ? parseWritingResult(payload.data, field) : null;
      if (!result) {
        setError(
          typeof payload.error === 'string' ? payload.error : '暂未生成可用文案，请稍后再试。',
        );
        return;
      }
      setOptions([...result.options]);
      setReminders(result.reminders);
      setMessage('已生成备选文案。请核对事实，可直接编辑备选再使用。尚未保存或发布。');
    } catch {
      setError('未收到生成结果，请稍后再试。简述和原文均已保留。');
    } finally {
      setPending(false);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage('已复制文案，请粘贴到对应字段并保存。');
    } catch {
      setError('未能复制，请选中文案手动复制。');
    }
  }
  return (
    <section
      className="writing-panel"
      aria-label={`${writingFields[field].label}填写助手`}
      aria-busy={pending}
    >
      <h3>帮我写 {writingFields[field].label}</h3>
      <p>简单说说你想表达什么。助手会参考当前字段原文，生成多个备选，不会自动保存或发布。</p>
      <label>
        简短描述
        <textarea
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          maxLength={1000}
          rows={3}
          placeholder={writingFields[field].example}
          disabled={pending}
        />
      </label>
      <small>{brief.length}/1000 字。请勿输入密码、密钥、客户隐私或未获授权的资料。</small>
      <label className="writing-consent">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          disabled={pending}
        />
        我同意将此简述和当前字段文字发送至阿里云千问生成文案。
      </label>
      <button type="button" onClick={() => void generate()} disabled={pending}>
        {pending ? '正在生成备选…' : options.length ? '重新生成备选' : '生成备选文案'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {options.length ? (
        <div className="writing-results">
          <p className="writing-warning">
            AI
            建议不等于已确认事实。使用前请核对价格、优惠、规格和承诺；未知信息应保留“需商家确认”。
          </p>
          {options.map((option, index) => (
            <article key={index}>
              <label>
                备选 {index + 1}
                <textarea
                  value={option}
                  maxLength={writingFields[field].maximum}
                  rows={writingFields[field].multiline ? 5 : 3}
                  onChange={(event) =>
                    setOptions((previous) =>
                      previous.map((text, position) =>
                        position === index ? event.target.value : text,
                      ),
                    )
                  }
                />
              </label>
              {onApply ? (
                <button
                  type="button"
                  disabled={pending || !option.trim()}
                  onClick={() => onApply(option.trim())}
                >
                  填入此字段
                </button>
              ) : (
                <button type="button" disabled={!option.trim()} onClick={() => void copy(option)}>
                  复制此文案
                </button>
              )}
            </article>
          ))}
          {reminders.length ? (
            <aside>
              <strong>还需要你确认</strong>
              <ul>
                {reminders.map((reminder) => (
                  <li key={reminder}>{reminder}</li>
                ))}
              </ul>
            </aside>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
