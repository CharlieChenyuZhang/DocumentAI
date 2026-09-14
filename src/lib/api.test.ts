import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  PDF_MAX_SIZE_BYTES,
  askQuestion,
  uploadDocument,
  validatePdf,
} from "./api";

const fetchMock = vi.fn<typeof fetch>();
const answers = {
  ragAnswer: "Document evidence",
  mcpAnswer: "External context",
};
const pdf = () =>
  new File(["%PDF-1.7\n"], "report.pdf", { type: "application/pdf" });

function abortableFetch() {
  fetchMock.mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("the existing backend contract", () => {
  it("uploads the PDF as multipart field file and accepts Express's text acknowledgement", async () => {
    const file = pdf();
    fetchMock.mockResolvedValue(
      new Response("uploads/report.pdf upload succeeded", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );

    await expect(uploadDocument(file)).resolves.toBe(
      "uploads/report.pdf upload succeeded",
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:5001/upload");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBe(file);
    // The browser must add the multipart boundary itself.
    expect(init?.headers).toBeUndefined();
  });

  it("encodes a question as one query parameter and bypasses browser caching", async () => {
    fetchMock.mockResolvedValue(Response.json(answers));
    const question = "Risk & growth? #1 日本語";

    await expect(askQuestion(`  ${question}  `)).resolves.toEqual(answers);

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe("http://localhost:5001");
    expect(parsed.pathname).toBe("/chat");
    expect([...parsed.searchParams.entries()]).toEqual([
      ["question", question],
    ]);
    expect(init).toMatchObject({ method: "GET", cache: "no-store" });
  });

  it("uses the configured API base without adding duplicate slashes", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_API_BASE_URL",
      " https://api.example.test/document/// ",
    );
    fetchMock.mockResolvedValue(Response.json(answers));

    await askQuestion("Summarize this");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.example.test/document/chat?question=Summarize+this",
    );
  });

  it("preserves empty answer strings so the UI can represent missing evidence", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ragAnswer: "", mcpAnswer: "" }),
    );
    await expect(askQuestion("Question")).resolves.toEqual({
      ragAnswer: "",
      mcpAnswer: "",
    });
  });
});

describe("safe request failures", () => {
  it("reports HTTP status without exposing a server's HTML or private error detail", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>secret stack trace</html>", { status: 500 }),
    );

    const error = await askQuestion("Question").catch(
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "http", status: 500 });
    expect((error as ApiError).message).not.toMatch(/html|secret|stack trace/);
  });

  it.each([
    null,
    [],
    {},
    { ragAnswer: "Only one" },
    { ...answers, mcpAnswer: 42 },
  ])("rejects malformed chat data: %j", async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    await expect(askQuestion("Question")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("rejects an HTML chat response even when the status is successful", async () => {
    fetchMock.mockResolvedValue(
      new Response("<!doctype html><html>Proxy page</html>"),
    );
    await expect(askQuestion("Question")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it.each(["", "  ", "<!doctype html><html>Proxy page</html>"])(
    "does not treat an invalid upload acknowledgement as a successful upload: %j",
    async (body) => {
      fetchMock.mockResolvedValue(new Response(body));
      await expect(uploadDocument(pdf())).rejects.toMatchObject({
        code: "invalid-response",
      });
    },
  );

  it("normalizes fetch errors into an actionable connection error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Private network details"));

    await expect(askQuestion("Question")).rejects.toMatchObject({
      code: "network",
      message: expect.stringContaining("server is running"),
    });
  });

  it("does not start a request if its caller has already canceled it", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      askQuestion("Question", { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "aborted",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards caller cancellation to fetch and clears the request timer", async () => {
    vi.useFakeTimers();
    abortableFetch();
    const controller = new AbortController();
    const pending = askQuestion("Question", { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "aborted",
    });

    controller.abort();

    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a chat request after 120 seconds", async () => {
    vi.useFakeTimers();
    abortableFetch();
    const pending = askQuestion("Question");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "timeout",
    });

    await vi.advanceTimersByTimeAsync(120_000);

    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the timeout active until the response body has finished", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_input, init) => {
      const response = new Response();
      vi.spyOn(response, "json").mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      );
      return response;
    });
    const pending = askQuestion("Question");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "timeout",
    });

    await vi.advanceTimersByTimeAsync(120_000);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("request validation", () => {
  it("rejects blank questions before a network request", async () => {
    await expect(askQuestion(" \n ")).rejects.toMatchObject({
      code: "validation",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported or empty files before uploading", async () => {
    for (const file of [
      new File(["text"], "report.txt", { type: "text/plain" }),
      new File(["text"], "report.pdf", { type: "text/plain" }),
      new File([], "empty.pdf", { type: "application/pdf" }),
    ]) {
      await expect(uploadDocument(file)).rejects.toMatchObject({
        code: "validation",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts PDF filenames with uppercase extensions or missing MIME metadata", () => {
    expect(validatePdf(new File(["%PDF-1.7"], "REPORT.PDF"))).toBeNull();
    expect(
      validatePdf(
        new File(["%PDF-1.7"], "report.pdf", {
          type: "application/octet-stream",
        }),
      ),
    ).toBeNull();
  });

  it("enforces the 20 MiB file limit, including the exact boundary", () => {
    const atLimit = new File(
      [new Uint8Array(PDF_MAX_SIZE_BYTES)],
      "report.pdf",
    );
    const overLimit = new File([atLimit, "x"], "report.pdf");

    expect(validatePdf(atLimit)).toBeNull();
    expect(validatePdf(overLimit)).toContain("20 MB");
  });
});
