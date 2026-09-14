import type { Principal } from "./session";
import { HttpError } from "./http";

export function serviceConnection(user: Principal) {
  const token = process.env.AGENT_SERVICE_TOKEN;
  if (!token || token.length < 32)
    throw new HttpError(
      503,
      "Configure AGENT_SERVICE_TOKEN before using the agent.",
    );
  const url = new URL(process.env.AGENT_SERVICE_URL || "http://127.0.0.1:8000");
  if (!["http:", "https:"].includes(url.protocol))
    throw new HttpError(503, "Invalid agent service URL.");
  return {
    base: url.toString().replace(/\/$/, ""),
    headers: {
      Authorization: `Bearer ${token}`,
      "x-documentai-owner": user.id,
    },
  };
}

export async function agentRequest(
  user: Principal,
  path: string,
  init: RequestInit = {},
  timeout = 180_000,
) {
  const { base, headers } = serviceConnection(user);
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      cache: "no-store",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
  } catch {
    throw new HttpError(
      503,
      "The agent service is unavailable. Start the agent service and try again.",
    );
  }
}

export async function proxyResult(
  response: Response,
  pdf = false,
): Promise<Response> {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = data.detail ?? data.error;
    throw new HttpError(
      response.status,
      typeof detail === "string"
        ? detail
        : "The agent could not complete this request.",
    );
  }
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  headers.set("Content-Type", pdf ? "application/pdf" : "application/json");
  if (pdf) headers.set("Content-Security-Policy", "sandbox");
  if (pdf)
    headers.set("Content-Disposition", 'inline; filename="document.pdf"');
  return new Response(response.body, { status: response.status, headers });
}
