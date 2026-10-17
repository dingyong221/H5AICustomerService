import { notFound, redirect } from 'next/navigation';
export default async function LegacyConversation({
  params,
}: {
  params: Promise<{ merchantId: string; sessionId: string }>;
}) {
  const { merchantId, sessionId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId) || !/^[0-9a-f]{32}$/u.test(sessionId)) notFound();
  redirect(`/${merchantId}/conversations/${sessionId}`);
}
