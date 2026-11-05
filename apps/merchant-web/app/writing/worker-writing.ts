import { checkMarketplaceModelError } from '../workspace/model-service-error';
import { parseWritingResult, type WritingInput, type WritingResult } from '@h5cs/contracts';
import { previewToken, previewWorkerUrl } from '../workspace/worker-preview';

export class WritingUnavailable extends Error {
  constructor(public readonly status: 429 | 503) {
    super('Writing unavailable');
  }
}

export async function requestWorkerWriting(
  merchantId: string,
  input: WritingInput,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<WritingResult> {
  const previewUrl = previewWorkerUrl(environment);
  const token = previewToken(environment);
  if (!previewUrl || !token) throw new WritingUnavailable(503);
  const url = new URL(previewUrl);
  url.pathname = '/internal/writing';
  const response = await fetchImpl(url.href, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(25_000),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-h5cs-preview-token': token,
    },
    body: JSON.stringify({ merchantId, ...input }),
  });
  await checkMarketplaceModelError(response);
  if (response.status === 429) throw new WritingUnavailable(429);
  if (
    response.status !== 200 ||
    !response.headers.get('content-type')?.includes('application/json')
  )
    throw new WritingUnavailable(503);
  const payload: unknown = await response.json();
  const data =
    typeof payload === 'object' && payload !== null && 'data' in payload ? payload.data : null;
  const result = parseWritingResult(data, input.field);
  if (!result) throw new WritingUnavailable(503);
  return result;
}
