import { describe, expect, it } from 'vitest';
import { helpTopics, manualMarkdown, manualUpdated, searchHelp } from './manual';

describe('material deletion and permanent consumer-link help', () => {
  it('documents the explicit combined publish action instead of the old dead end', () => {
    expect(manualUpdated).toBe('2026-10-21');
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
});
