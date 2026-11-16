import { organizationRoute } from '../../../../../../../knowledge/organization-http';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ merchantId: string; assistantId: string; taskId: string }> },
) {
  return organizationRoute(request, await params, 'cancel');
}
