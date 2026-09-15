import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { HttpAgent } from "@ag-ui/client";
import { requirePrincipal } from "@/lib/server/session";
import { serviceConnection } from "@/lib/server/agent-service";
import { ScopedRunner } from "@/lib/server/scoped-runner";
import { cancellableRunResponse } from "@/lib/server/run-stream";
import {
  assertSameOrigin,
  boundedBody,
  errorResponse,
  HttpError,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 240;
const ALLOWED =
  /^\/api\/copilotkit\/(info|agent\/document_ai\/(run|connect|stop\/[a-zA-Z0-9_-]{1,128}))\/?$/;

async function handle(request: Request) {
  try {
    assertSameOrigin(request);
    if (!ALLOWED.test(new URL(request.url).pathname))
      throw new HttpError(404, "Endpoint not found.");
    const user = await requirePrincipal();
    const connection = serviceConnection(user);
    const runner = new ScopedRunner(
      user.id,
      undefined,
      process.env.VECTOR_BACKEND === "local" ? "local" : "pinecone",
    );
    const pathname = new URL(request.url).pathname.replace(/\/$/, "");
    if (pathname.includes("/stop/")) {
      const runId = request.headers.get("x-documentai-run-id");
      if (!runId || !/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
        throw new HttpError(
          400,
          "An exact run ID is required to stop a response.",
        );
      }
      const threadId = pathname.split("/").filter(Boolean).at(-1)!;
      const stopped = await runner.stop({ threadId, runId });
      return Response.json(
        { stopped: !!stopped },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    let incoming = request;
    let run: { threadId: string; runId: string } | undefined;
    if (request.method === "POST") {
      const bytes = await boundedBody(request, 512 * 1024);
      if (pathname.endsWith("/run")) {
        let data;
        try {
          data = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new HttpError(400, "Invalid agent request.");
        }
        if (
          !data ||
          typeof data.threadId !== "string" ||
          typeof data.runId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(data.threadId) ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(data.runId)
        ) {
          throw new HttpError(400, "Invalid conversation or run ID.");
        }
        run = { threadId: data.threadId, runId: data.runId };
      }
      incoming = new Request(request.url, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
        signal: request.signal,
      });
    }
    const copilot = new CopilotRuntime({
      agents: {
        document_ai: new HttpAgent({
          url: `${connection.base}/run`,
          headers: connection.headers,
        }),
      },
      runner,
      forwardHeaders: { allow: [] },
    });
    const handler = createCopilotRuntimeHandler({
      runtime: copilot,
      basePath: "/api/copilotkit",
    });
    const response = await handler(incoming);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Accel-Buffering", "no");
    return run && response.ok
      ? cancellableRunResponse(response, request.signal, () =>
          runner.stop(run!),
        )
      : response;
  } catch (error) {
    return errorResponse(error);
  }
}
export const GET = handle;
export const POST = handle;
