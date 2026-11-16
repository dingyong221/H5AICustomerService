import {
  parseWritingInput,
  parseWritingResult,
  type WritingInput,
  type WritingResult,
} from '@h5cs/contracts';
import type { ConversationTurnGenerator } from './conversation-turn-processor.js';
import type { ModelContext } from './model-runtime.js';
import { buildWritingPrompt, groundFinancialWriting } from './writing-prompt.js';
import { buildPreviewPrompt, type PreviewFacts } from './conversation-prompt.js';
export async function generateDraftExpansion(
  generator: ConversationTurnGenerator,
  raw: WritingInput,
  signal: AbortSignal,
  context: ModelContext,
): Promise<WritingResult> {
  const input = parseWritingInput(raw);
  if (!input) throw Error('Invalid writing input');
  const answer = await generator.generate(buildWritingPrompt(input), signal, context);
  const parsed = parseWritingResult(JSON.parse(answer), input.field);
  if (!parsed) throw Error('Invalid writing answer');
  const result = groundFinancialWriting(input, parsed);
  const labeled =
    input.field === 'welcomeMessage'
      ? parseWritingResult(
          {
            ...result,
            options: result.options.map((text) =>
              /\bAI\b|人工智能/iu.test(text) ? text : `您好，我是 AI 客服。${text}`,
            ),
          },
          input.field,
        )
      : result;
  if (!labeled) throw Error('Invalid labeled writing answer');
  return labeled;
}
export const generatePreviewReply = (
  generator: ConversationTurnGenerator,
  facts: PreviewFacts,
  question: string,
  signal: AbortSignal,
  context: ModelContext,
) => generator.generate(buildPreviewPrompt(facts, question), signal, context);
