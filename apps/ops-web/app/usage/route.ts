import { collectUsageRequest } from '@h5cs/database';
import { currentOperator } from '../operator-actions';
export async function POST(request: Request) {
  try {
    const operator = await currentOperator();
    if (!operator) return new Response(null, { status: 401 });
    return await collectUsageRequest(request, process.env['OPS_PUBLIC_ORIGIN'], {
      role: 'operator',
      id: operator,
    });
  } catch {
    return Response.json(
      { collected: false },
      { status: 202, headers: { 'cache-control': 'no-store' } },
    );
  }
}
