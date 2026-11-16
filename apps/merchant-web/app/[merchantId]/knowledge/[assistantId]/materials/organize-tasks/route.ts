import { organizationRoute } from '../../../../../knowledge/organization-http';
type Context = { params: Promise<{ merchantId: string; assistantId: string }> };
export async function POST(request: Request, { params }: Context) {
  return organizationRoute(request, await params, 'create');
}
export async function GET(request: Request, { params }: Context) {
  return organizationRoute(request, await params, 'find');
}
