// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { requirePrincipal } from "../../../lib/server/session";
import { HttpError } from "../../../lib/server/http";

vi.mock("../../../lib/server/session", () => ({ requirePrincipal: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const url = "http://localhost:3001/api/speech";
const speech = (
  body: unknown = { text: "Hello, 你好。" },
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) =>
  new Request(url, {
    method: "POST",
    headers: {
      origin: "http://localhost:3001",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });

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
  fetchMock.mockImplementation(
    async () =>
      new Response(new Uint8Array([73, 68, 51, 1]), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("OpenAI speech proxy", () => {
  it("forwards only text with trusted credentials and returns uncached audio bytes", async () => {
    const response = await POST(
      speech(
        { text: "  Hello, 你好。  ", model: "untrusted", voice: "untrusted" },
        {
          authorization: "Bearer attacker",
          "x-documentai-owner": "session:bob",
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      73, 68, 51, 1,
    ]);
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe("http://agent.internal:8000/speech");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test-private-token-with-at-least-32-characters",
      "x-documentai-owner": "session:alice",
    });
    expect(JSON.parse(init?.body as string)).toEqual({ text: "Hello, 你好。" });
  });

  it("blocks cross-origin and unauthenticated requests before provider work", async () => {
    expect(
      (await POST(speech(undefined, { origin: "https://attacker.example" })))
        .status,
    ).toBe(403);
    expect(requirePrincipal).not.toHaveBeenCalled();
    vi.mocked(requirePrincipal).mockRejectedValue(
      new HttpError(401, "Sign in first."),
    );
    expect((await POST(speech())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized requests, including streaming bodies without content-length", async () => {
    for (const body of [null, [], {}, { text: 123 }, { text: " \n " }])
      expect((await POST(speech(body))).status).toBe(400);
    expect(
      (
        await POST(
          new Request(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await POST(speech(undefined, { "Content-Type": "text/plain" }))).status,
    ).toBe(415);
    expect((await POST(speech({ text: "a".repeat(3001) }))).status).toBe(413);
    expect(
      (await POST(speech({ text: "ok", ignored: "x".repeat(32 * 1024) })))
        .status,
    ).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts Unicode characters without splitting surrogate pairs", async () => {
    expect((await POST(speech({ text: "😀".repeat(3000) }))).status).toBe(200);
    expect((await POST(speech({ text: "😀".repeat(3001) }))).status).toBe(413);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation even after audio headers arrive", async () => {
    const abort = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(async (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            upstreamSignal?.addEventListener("abort", () =>
              controller.error(new Error("cancelled")),
            );
          },
        }),
        { headers: { "Content-Type": "audio/mpeg" } },
      );
    });
    const pending = POST(speech(undefined, {}, abort.signal));
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    abort.abort();
    expect((await pending).status).toBe(502);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("rejects non-audio, empty and excessive upstream responses", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ secret: "private diagnostic" }),
    );
    const invalid = await POST(speech());
    expect(invalid.status).toBe(502);
    expect(await invalid.text()).not.toContain("private diagnostic");
    fetchMock.mockResolvedValueOnce(
      new Response(null, { headers: { "Content-Type": "audio/mpeg" } }),
    );
    expect((await POST(speech())).status).toBe(502);
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
    );
    expect((await POST(speech())).status).toBe(502);
  });

  it("preserves actionable service errors and hides network diagnostics", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          detail:
            "Read aloud is temporarily rate limited. Please try again shortly.",
        },
        { status: 429 },
      ),
    );
    const limited = await POST(speech());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error:
        "Read aloud is temporarily rate limited. Please try again shortly.",
    });
    fetchMock.mockRejectedValueOnce(new Error("internal secret"));
    const unavailable = await POST(speech());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("internal secret");
  });
});
