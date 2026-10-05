'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { helpTopics, manualText, manualUpdated, searchHelp } from './manual';
import { merchantPath } from '../tenant-paths';

export function HelpCenter({ merchantId }: { merchantId: string }) {
  const [query, setQuery] = useState('');
  const topics = searchHelp(query);
  useEffect(() => {
    const reveal = () => {
      const target = document.getElementById(window.location.hash.slice(1));
      if (target instanceof HTMLDetailsElement) {
        target.open = true;
        target.scrollIntoView({ block: 'start' });
      }
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, []);
  function download() {
    const url = URL.createObjectURL(
      new Blob(['\uFEFF', manualText()], { type: 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = '商家AI客服使用手册.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="help-center">
      <section className="help-overview">
        <h2>让顾客用上 AI 客服 先走这四步</h2>
        <ol className="help-quick-steps">
          {['创建并保存草稿', '确认知识资料', '试聊并发布', '分享链接给顾客'].map((step, index) => (
            <li key={step}>
              <span>{index + 1}</span>
              {step}
            </li>
          ))}
        </ol>
        <p>“帮我写”只整理文案；创建只保存草稿。核对资料并发布后，才会开放消费者对话。</p>
        <Link href={merchantPath(merchantId, 'drafts')}>开始配置自己的客服</Link>
      </section>
      <div className="help-tools">
        <label>
          查找操作或问题
          <input
            type="search"
            placeholder="例如：价格、发布、二维码、登录、帮我写"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="button" onClick={download}>
          下载使用手册
        </button>
      </div>
      <p role="status">
        {query
          ? `找到 ${topics.length} 个相关主题`
          : `共 ${helpTopics.length} 个主题，点击标题查看步骤`}{' '}
        · 更新于 {manualUpdated}
      </p>
      {!topics.length ? (
        <div className="help-empty">
          <p>暂未找到匹配内容。可以换成“保存”“试聊”或“账号”等关键词。</p>
          <button type="button" onClick={() => setQuery('')}>
            查看全部帮助
          </button>
        </div>
      ) : null}
      <div className="help-topics">
        {topics.map((topic) => (
          <details key={topic.id} id={topic.id} className="help-topic">
            <summary>
              {topic.title}
              <span>{topic.summary}</span>
            </summary>
            <div className="help-topic__body">
              <h3>操作步骤</h3>
              <ol>
                {topic.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {topic.example ? (
                <aside className="help-example">
                  <strong>填写示例</strong>
                  <p>{topic.example}</p>
                </aside>
              ) : null}
              <h3>请注意</h3>
              <ul>
                {topic.tips.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
              <Link className="help-action" href={merchantPath(merchantId, topic.section)}>
                {topic.action} →
              </Link>
            </div>
          </details>
        ))}
      </div>
      <aside className="help-support">
        <h2>仍然遇到问题</h2>
        <p>
          请联系为你开通账号的平台运营，提供操作时间、页面名称、客服名称和错误提示。截图前遮盖个人信息；不要发送密码、密钥或一次性领取令牌。
        </p>
      </aside>
    </div>
  );
}
