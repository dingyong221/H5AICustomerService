import { describe, expect, it } from 'vitest';
import { helpTopics, manualMarkdown, manualUpdated, searchHelp } from './manual';

describe('material deletion and permanent consumer-link help', () => {
  it('explains the four task pages and puts file upload inside the normal publishing journey', () => {
    const start = helpTopics.find((entry) => entry.id === 'start')!;
    expect(start.summary).toContain('基础资料 → 知识补充 → 效果试聊 → 发布分享');
    expect(start.steps).toHaveLength(4);
    expect(start.steps[1]).toContain('上传文件');
    expect(helpTopics.find((entry) => entry.id === 'preview')?.section).toBe('preview');
    const publish = helpTopics.find((entry) => entry.id === 'publish')!;
    expect(publish.steps.join('\n')).not.toContain('知识库与测试发布页均提供确认并发布入口');
  });
  it('documents the explicit combined publish action instead of the old dead end', () => {
    expect(manualUpdated).toBe('2026-10-26');
    for (const id of ['start', 'knowledge', 'publish']) {
      const topic = helpTopics.find((entry) => entry.id === id)!;
      expect(topic.steps.join('\n')).toContain('确认资料并发布 AI 客服');
      expect(topic.steps.join('\n')).not.toContain('确认当前草稿资料');
    }
  });
  it('explains deletion consent, selection removal and saved/published-content boundaries', () => {
    expect(searchHelp('删除材料').map((entry) => entry.id)).toContain('knowledge');
    const topic = helpTopics.find((entry) => entry.id === 'knowledge')!;
    expect(topic.steps.join('\n')).toContain('确认删除');
    expect(topic.tips.join('\n')).toContain('不会自动删改已经保存进草稿');
    expect(topic.tips.join('\n')).toContain('核对并重新发布');
  });
  it('explains link retention and versioned sessions in the downloadable manual too', () => {
    const text = manualMarkdown();
    expect(text).toContain('长期沿用一个消费者链接');
    expect(text).toContain('不会更换地址');
    expect(text).toContain('旧会话仍使用建立时的版本');
    expect(text).toContain('消费者地址包含“/a/”');
  });
  it('explains history recovery as a new unconfirmed draft, not an instant public rollback or original-file recovery', () => {
    expect(searchHelp('恢复业务资料').map((entry) => entry.id)).toContain('history');
    const history = helpTopics.find((entry) => entry.id === 'history')!;
    expect(history.steps.join('\n')).toContain('清除资料确认，不直接上线');
    expect(history.steps.join('\n')).toContain('重新确认并发布');
    expect(history.tips.join('\n')).toContain('不重建已删除的原始附件');
    expect(manualMarkdown()).toContain('改善任务不会随恢复自动撤销或重新打开');
  });
});
