import { requirePrincipal } from "@/lib/server/session";
import { agentRequest, proxyResult } from "@/lib/server/agent-service";
import { assertSameOrigin, errorResponse, HttpError } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };
function path(id: string) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id))
    throw new HttpError(400, "Invalid document ID.");
  return `/documents/${id}`;
}
export async function GET(_request: Request, context: Context) {
  try {
    return await proxyResult(
      await agentRequest(
        await requirePrincipal(),
        path((await context.params).id),
      ),
      true,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    return await proxyResult(
      await agentRequest(
        await requirePrincipal(),
        path((await context.params).id),
        { method: "DELETE", signal: request.signal },
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
