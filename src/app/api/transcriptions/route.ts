import { requirePrincipal } from "../../../lib/server/session";
import { agentRequest, proxyResult } from "../../../lib/server/agent-service";
import {
  assertSameOrigin,
  boundedBody,
  errorResponse,
  HttpError,
} from "../../../lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 75;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requirePrincipal();
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;"))
      throw new HttpError(415, "Record audio using the microphone button.");
    const body = await boundedBody(request, 8 * 1024 * 1024 + 64 * 1024);
    return await proxyResult(
      await agentRequest(
        user,
        "/transcriptions",
        {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: new Blob([body as Uint8Array<ArrayBuffer>]),
          signal: request.signal,
        },
        65_000,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
