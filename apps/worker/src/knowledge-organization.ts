import { parseMaterialOrganization, type MaterialOrganization } from '@h5cs/contracts';
import { buildKnowledgePrompt } from './knowledge-prompt.js';
import { renderKnowledgeOrganization } from './knowledge-grounding.js';
import type { ConversationTurnGenerator } from './conversation-turn-processor.js';
import type { ModelContext } from './model-runtime.js';

/** Same grounding and output checks for synchronous and persistent organization. */
export async function generateKnowledgeOrganization(
  generator: ConversationTurnGenerator,
  text: string,
  signal: AbortSignal,
  context: ModelContext,
): Promise<MaterialOrganization> {
  const output = await generator.generate(buildKnowledgePrompt(text), signal, context);
  const result = parseMaterialOrganization(renderKnowledgeOrganization(text, JSON.parse(output)));
  if (!result) throw new Error('Invalid material reference plan');
  const numbers = (value: string) => value.match(/[-+−]?\d+(?:[.,]\d+)*(?:[%％])?/gu) ?? [];
  const allowed = new Set(numbers(text));
  if (
    [result.summary, ...result.warnings].some((value) =>
      numbers(value).some((number) => !allowed.has(number)),
    )
  )
    throw new Error('Invented number');
  return result;
}
