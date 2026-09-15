// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { requirePrincipal } from "../../../lib/server/session";
import { HttpError } from "../../../lib/server/http";

vi.mock("../../../lib/server/session", () => ({ requirePrincipal: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const url = "http://localhost:3001/api/transcriptions";

function recording(headers: Record<string, string> = {}, signal?: AbortSignal) {
  const form = new FormData();
  form.set(
    "file",
    new Blob(["audio"], { type: "audio/webm" }),
    "recording.webm",
  );
  return new Request(url, {
    method: "POST",
    headers: { origin: "http://localhost:3001", ...headers },
    body: form,
    signal,
  });
}

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "http://localhost:3001");
  vi.stubEnv(
    "AGENT_SERVICE_TOKEN",
    "test-private-token-with-at-least-32-characters",
  );
  vi.stubEnv("AGENT_SERVICE_URL", "http://agent.internal:8000");
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(requirePrincipal).mockResolvedValue({
    id: "session:alice",
    name: "Alice",
    kind: "session",
  });
  fetchMock.mockResolvedValue(Response.json({ text: "比较 both reports" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("voice transcription proxy", () => {
  it("uses the server principal and private credentials and returns uncached text", async () => {
    const response = await POST(
      recording({
        "x-documentai-owner": "session:bob",
        authorization: "Bearer attacker",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "比较 both reports" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe("http://agent.internal:8000/transcriptions");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test-private-token-with-at-least-32-characters",
      "x-documentai-owner": "session:alice",
    });
    expect(await (init?.body as Blob).text()).toContain("audio");
  });

  it("rejects cross-origin and unauthenticated uploads before contacting the service", async () => {
    expect(
      (await POST(recording({ origin: "https://attacker.example" }))).status,
    ).toBe(403);
    expect(requirePrincipal).not.toHaveBeenCalled();
    vi.mocked(requirePrincipal).mockRejectedValue(
      new HttpError(401, "Sign in first."),
    );
    expect((await POST(recording())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects incorrect content types and oversized uploads", async () => {
    expect(
      (
        await POST(
          new Request(url, {
            method: "POST",
            body: "audio",
            headers: { "content-type": "text/plain" },
          }),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await POST(
          recording({
            "content-length": String(8 * 1024 * 1024 + 64 * 1024 + 1),
          }),
        )
      ).status,
    ).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards cancellation to the private service", async () => {
    const abort = new AbortController();
    await POST(recording({}, abort.signal));
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    abort.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("returns actionable sanitized service errors and hides network internals", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { detail: "Voice transcription timed out. Try a shorter recording." },
        { status: 504 },
      ),
    );
    const failed = await POST(recording());
    expect(failed.status).toBe(504);
    expect(await failed.json()).toEqual({
      error: "Voice transcription timed out. Try a shorter recording.",
    });
    fetchMock.mockRejectedValueOnce(new Error("internal secret"));
    const unavailable = await POST(recording());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("internal secret");
  });
});
