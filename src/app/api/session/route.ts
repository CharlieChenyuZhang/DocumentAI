import { principal, authMode } from "@/lib/server/session";
import { agentRequest } from "@/lib/server/agent-service";
import { assertSameOrigin, errorResponse } from "@/lib/server/http";

export async function GET(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await principal(true);
    let configuration: { ready: boolean; missing: string[] } = {
      ready: false,
      missing: [],
    };
    if (user) {
      try {
        const health = await agentRequest(user, "/health", {}, 3000);
        if (health.ok) configuration = await health.json();
        else configuration.missing = ["AGENT_SERVICE"];
      } catch {
        configuration.missing = ["AGENT_SERVICE"];
      }
    }
    return Response.json(
      { user, authMode: authMode(), authenticated: !!user, configuration },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
