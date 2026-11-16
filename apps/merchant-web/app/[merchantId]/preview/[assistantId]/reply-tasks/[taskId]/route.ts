import { authoringRoute } from '../../../../../tasks/authoring-http';
type Context = { params: Promise<{ merchantId: string; assistantId: string; taskId: string }> };
export async function GET(request: Request, { params }: Context) {
  return authoringRoute(request, await params, 'preview.reply', 'get');
}
