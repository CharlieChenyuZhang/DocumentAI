import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  PDF_MAX_SIZE_BYTES,
  deleteDocument,
  getSession,
  listDocuments,
  uploadDocument,
  validatePdf,
} from "./api";
const fetchMock = vi.fn<typeof fetch>();
const document = {
  id: "doc-1",
  name: "report.pdf",
  size: 100,
  pages: 1,
  chunks: 2,
  status: "ready",
  created_at: "2026-09-14T00:00:00Z",
};
const pdf = () =>
  new File(["%PDF-1.7\n"], "report.pdf", { type: "application/pdf" });
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("authenticated document API", () => {
  it("uploads once to the same-origin route as multipart and returns its persistent document ID", async () => {
    const file = pdf();
    fetchMock.mockResolvedValue(Response.json({ document }));
    await expect(uploadDocument(file)).resolves.toEqual(document);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/documents");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect((init?.body as FormData).get("file")).toBe(file);
    expect(init?.headers).toBeUndefined();
  });
  it("loads only the library returned by the authenticated route without accepting a user ID", async () => {
    fetchMock.mockResolvedValue(Response.json({ documents: [document] }));
    await expect(listDocuments()).resolves.toEqual([document]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/documents");
  });
  it("encodes document IDs for deletion", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await deleteDocument("some/id");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/documents/some%2Fid");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
  });
  it("validates the session identity before the UI can restore history", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        authenticated: true,
        authMode: "github",
        user: { name: "missing-id" },
      }),
    );
    await expect(getSession()).rejects.toMatchObject({
      code: "invalid-response",
    });
  });
  it("accepts signed-out session state", async () => {
    const session = { authenticated: false, authMode: "github", user: null };
    fetchMock.mockResolvedValue(Response.json(session));
    await expect(getSession()).resolves.toEqual(session);
  });
});
describe("safe request failures", () => {
  it.each([
    [
      "The OpenAI API key is invalid or has been revoked. Update OPENAI_API_KEY and restart the agent service.",
      "The OpenAI API key is no longer valid. Update the workspace API key and restart the agent service, then retry.",
    ],
    [
      "Complete the agent service configuration before uploading or searching documents.",
      "Document storage needs setup before files can be loaded.",
    ],
    [
      "Document storage is not configured. Private provider details omitted.",
      "Complete the workspace configuration, then retry.",
    ],
    [
      "The agent service is unavailable. Start the agent service and try again.",
      "Check that the agent service is running, then retry.",
    ],
  ])(
    "maps known service errors to safe, actionable instructions: %s",
    async (error, expected) => {
      fetchMock.mockResolvedValue(Response.json({ error }, { status: 503 }));
      const failure = await listDocuments().catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ code: "http", status: 503 });
      expect((failure as Error).message).toContain(expected);
      expect((failure as Error).message).not.toContain("Private provider");
    },
  );
  it.each([
    Response.json(
      {
        error:
          "The OpenAI API key is invalid or has been revoked. Update OPENAI_API_KEY and restart the agent service. Credentials: PRIVATE_CREDENTIAL_SENTINEL.",
      },
      { status: 503 },
    ),
    Response.json(
      { error: "Private provider credential and stack trace" },
      { status: 503 },
    ),
    new Response("<html>Private proxy diagnostics</html>", { status: 503 }),
  ])("does not display unknown 503 error content", async (response) => {
    fetchMock.mockResolvedValue(response);
    await expect(listDocuments()).rejects.toMatchObject({
      status: 503,
      message:
        "The service is temporarily unavailable. Please try again in a moment.",
    });
  });
  it("hides raw server errors and describes expired sessions", async () => {
    fetchMock.mockResolvedValue(
      new Response("private stack trace", { status: 401 }),
    );
    const error = await listDocuments().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: "http" });
    expect((error as Error).message).toContain("session has expired");
    expect((error as Error).message).not.toContain("stack");
  });
  it.each([
    null,
    [],
    {},
    { documents: [{}] },
    { documents: [{ ...document, id: 1 }] },
  ])("rejects malformed library response %j", async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    await expect(listDocuments()).rejects.toMatchObject({
      code: "invalid-response",
    });
  });
  it("rejects HTML pretending to be a successful upload", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>private proxy page</html>"),
    );
    await expect(uploadDocument(pdf())).rejects.toMatchObject({
      code: "invalid-response",
    });
  });
  it("normalizes connection errors", async () => {
    fetchMock.mockRejectedValue(new TypeError("private network"));
    await expect(listDocuments()).rejects.toMatchObject({
      code: "network",
      message: expect.stringContaining("server is running"),
    });
  });
  it("does not start an already canceled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      listDocuments({ signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("cancels uploads and clears their timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        ),
    );
    const controller = new AbortController();
    const pending = uploadDocument(pdf(), { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "aborted",
    });
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("allows indexing time but eventually times out an upload", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        ),
    );
    const pending = uploadDocument(pdf());
    const assertion = expect(pending).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe("PDF validation", () => {
  it("rejects non-PDF and empty files before uploading", async () => {
    for (const file of [
      new File(["text"], "report.txt"),
      new File(["text"], "report.pdf", { type: "text/plain" }),
      new File([], "empty.pdf"),
    ])
      await expect(uploadDocument(file)).rejects.toMatchObject({
        code: "validation",
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("allows uppercase PDF suffix and absent MIME metadata", () => {
    expect(validatePdf(new File(["%PDF-1.7"], "REPORT.PDF"))).toBeNull();
  });
  it("enforces 20 MiB including the exact boundary", () => {
    const atLimit = new File(
      [new Uint8Array(PDF_MAX_SIZE_BYTES)],
      "report.pdf",
    );
    expect(validatePdf(atLimit)).toBeNull();
    expect(validatePdf(new File([atLimit, "x"], "report.pdf"))).toContain(
      "20 MB",
    );
  });
});
