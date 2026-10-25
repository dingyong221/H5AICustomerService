import { describe, expect, it } from 'vitest';
import { selectConversationContext } from '../src/conversation-prompt.js';
const turn = (n: number, size = 10) => [
  { role: 'visitor' as const, content: `question-${n}` },
  { role: 'assistant' as const, content: String(n).repeat(size) },
];
describe('session-scoped bounded conversation context', () => {
  it('keeps the latest twelve whole turns in order without mutating the full stored history', () => {
    const history = Array.from({ length: 18 }, (_, i) => turn(i)).flat(),
      original = [...history];
    const selected = selectConversationContext(history);
    expect(selected).toHaveLength(24);
    expect(selected[0]?.content).toBe('question-6');
    expect(selected.at(-2)?.content).toBe('question-17');
    expect(history).toEqual(original);
  });
  it('stops at the character budget without an orphaned answer or an out-of-order older turn', () => {
    const history = [...turn(1, 8000), ...turn(2, 8000), ...turn(3, 100)];
    expect(selectConversationContext(history)).toEqual([...turn(2, 8000), ...turn(3, 100)]);
    expect(
      selectConversationContext(history).reduce((n, m) => n + m.content.length, 0),
    ).toBeLessThanOrEqual(16000);
  });
  it.each(
    [
      [{ role: 'visitor' as const, content: 'unfinished' }],
      [
        { role: 'assistant' as const, content: 'foreign answer' },
        { role: 'visitor' as const, content: 'wrong order' },
      ],
      [
        { role: 'visitor' as const, content: '' },
        { role: 'assistant' as const, content: 'answer' },
      ],
    ].map((history) => ({ history })),
  )(
    'rejects corrupted or incomplete turns instead of silently joining another context',
    ({ history }) => expect(() => selectConversationContext(history)).toThrow(),
  );
  it('starts new consumers with an empty model history', () =>
    expect(selectConversationContext([])).toEqual([]));
});
