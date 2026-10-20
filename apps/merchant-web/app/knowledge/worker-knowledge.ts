import { parseMaterialOrganization, type MaterialOrganization } from '@h5cs/contracts';
import { previewToken, previewWorkerUrl } from '../workspace/worker-preview';
export async function requestKnowledgeOrganization(
  merchantId: string,
  text: string,
): Promise<MaterialOrganization> {
  const base = previewWorkerUrl(process.env),
    token = previewToken(process.env);
  if (!base || !token) throw new Error('Unavailable');
  const url = new URL(base);
  url.pathname = '/internal/knowledge';
  const response = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
    headers: { 'Content-Type': 'application/json', 'x-h5cs-preview-token': token },
    body: JSON.stringify({ merchantId, text }),
  });
  if (!response.ok) throw new Error('Organization failed');
  const payload = (await response.json()) as { data?: unknown };
  const result = parseMaterialOrganization(payload.data);
  if (!result) throw new Error('Invalid organization');
  return result;
}
