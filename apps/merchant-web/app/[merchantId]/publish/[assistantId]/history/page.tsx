import { ReleaseHistoryView } from '../../../../release-history-view';
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ merchantId: string; assistantId: string }>;
  searchParams: Promise<{ before?: string | string[] }>;
}) {
  const scope = await params;
  return <ReleaseHistoryView {...scope} before={(await searchParams).before} />;
}
