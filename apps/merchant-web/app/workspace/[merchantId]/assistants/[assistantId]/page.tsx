import { notFound, redirect } from 'next/navigation';
export default async function LegacyAssistant({
  params,
}: {
  params: Promise<{ merchantId: string; assistantId: string }>;
}) {
  const { merchantId, assistantId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId) || !/^[0-9a-f]{32}$/u.test(assistantId)) notFound();
  redirect(`/${merchantId}/drafts/${assistantId}`);
}
