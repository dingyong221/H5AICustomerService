import { AssistantView } from '../../../assistant-view';
export default async function Page({
  params,
}: {
  params: Promise<{ merchantId: string; assistantId: string }>;
}) {
  const { merchantId, assistantId } = await params;
  return <AssistantView merchantId={merchantId} assistantId={assistantId} section="publish" />;
}
