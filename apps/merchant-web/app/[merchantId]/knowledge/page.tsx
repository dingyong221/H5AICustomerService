import { AssistantCollection } from '../../assistant-collection';
export default async function Page({ params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await params;
  return <AssistantCollection merchantId={merchantId} section="knowledge" />;
}
