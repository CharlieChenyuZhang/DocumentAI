import { requirePrincipal } from "@/lib/server/session";
import { agentRequest, proxyResult } from "@/lib/server/agent-service";
import {
  assertSameOrigin,
  boundedBody,
  errorResponse,
  HttpError,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET() {
  try {
    return await proxyResult(
      await agentRequest(await requirePrincipal(), "/documents"),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requirePrincipal();
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data;"))
      throw new HttpError(415, "Upload a PDF using the file picker.");
    const body = await boundedBody(request, 20 * 1024 * 1024 + 64 * 1024);
    return await proxyResult(
      await agentRequest(user, "/documents", {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: new Blob([body as Uint8Array<ArrayBuffer>]),
        signal: request.signal,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
