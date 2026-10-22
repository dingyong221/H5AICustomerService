import { ReleaseHistoryView } from '../../../../../release-history-view';
export default async function Page({
  params,
}: {
  params: Promise<{ merchantId: string; assistantId: string; releaseId: string }>;
}) {
  return <ReleaseHistoryView {...await params} />;
}
