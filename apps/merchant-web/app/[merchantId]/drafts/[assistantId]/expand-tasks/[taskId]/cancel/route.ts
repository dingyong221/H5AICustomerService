import { authoringRoute } from '../../../../../../tasks/authoring-http';
type Context = { params: Promise<{ merchantId: string; assistantId: string; taskId: string }> };
export async function POST(request: Request, { params }: Context) {
  return authoringRoute(request, await params, 'draft.expand', 'cancel');
}
