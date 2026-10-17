import { notFound, redirect } from 'next/navigation';
export default async function LegacyConversations({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) notFound();
  redirect(`/${merchantId}/conversations`);
}
