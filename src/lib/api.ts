export const PDF_MAX_SIZE_BYTES = 20 * 1024 * 1024;

export type ApiErrorCode =
  | "network"
  | "http"
  | "invalid-response"
  | "timeout"
  | "aborted"
  | "validation";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status?: number;

  constructor(message: string, code: ApiErrorCode, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export type RequestOptions = { signal?: AbortSignal };

export type DocumentInfo = {
  id: string;
  name: string;
  size: number;
  pages: number;
  chunks: number;
  status: string;
  created_at: string;
};
export type SessionInfo = {
  user: { id: string; name?: string; kind: "session" | "github" } | null;
  authMode: "session" | "github";
  authenticated: boolean;
  configuration?: Record<string, unknown>;
};

/** Matches the PDF-only loader supported by the existing backend. */
export function validatePdf(file: File): string | null {
  if (
    !file.name.toLowerCase().endsWith(".pdf") ||
    (file.type !== "" &&
      file.type !== "application/pdf" &&
      file.type !== "application/octet-stream")
  ) {
    return "Choose a PDF document (.pdf).";
  }
  if (file.size === 0) return "This PDF is empty. Choose a different document.";
  if (file.size > PDF_MAX_SIZE_BYTES) {
    return "This PDF is too large. Choose a document of 20 MB or less.";
  }
  return null;
}

async function httpError(response: Response): Promise<ApiError> {
  const status = response.status;
  if (status === 401)
    return new ApiError(
      "Your session has expired. Reload the page to sign in.",
      "http",
      status,
    );
  // Match known public errors and use our own copy. Never display arbitrary
  // provider diagnostics, HTML, credentials, or stack traces from a response.
  const payload: unknown = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? await response.json().catch(() => null)
    : null;
  const detail =
    isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
  if (
    detail ===
      "Complete the agent service configuration before uploading or searching documents." ||
    detail.startsWith("Document storage is not configured.")
  ) {
    return new ApiError(
      "Document storage needs setup before files can be loaded. Complete the workspace configuration, then retry.",
      "http",
      status,
    );
  }
  const safeMessages: Record<string, string> = {
    "Configure OPENAI_API_KEY and restart the agent service to use voice input.":
      "Voice input needs an OpenAI API key. Update the workspace configuration and restart the agent service.",
    "The voice transcription model is unavailable. Check OPENAI_TRANSCRIPTION_MODEL and project model access, then restart the agent service.":
      "The voice model is unavailable. Check the workspace transcription model and OpenAI project access, then retry.",
    "Voice transcription could not connect to OpenAI. Check the agent service network and try again.":
      "The voice service could not connect to OpenAI. Check the agent service connection, then retry.",
    "Voice transcription timed out. Try a shorter recording.":
      "Voice transcription timed out. Try a shorter recording.",
    "The recording could not be transcribed. Please record again.":
      "The recording could not be transcribed. Please record again.",
    "The transcript is too long. Please record a shorter question.":
      "The transcript is too long. Please record a shorter question.",
    "This audio format is not supported. Please try another browser.":
      "This audio format is not supported. Please try another browser.",
    "The OpenAI API key is invalid or has been revoked. Update OPENAI_API_KEY and restart the agent service.":
      "The OpenAI API key is no longer valid. Update the workspace API key and restart the agent service, then retry.",
    "The agent service is unavailable. Start the agent service and try again.":
      "Document service is unavailable. Check that the agent service is running, then retry.",
    "Configure AGENT_SERVICE_TOKEN before using the agent.":
      "Document service needs setup. Complete the workspace configuration, then retry.",
    "Re-upload these documents after changing the embedding model.":
      "The document index has changed. Upload these documents again before asking another question.",
    "Some document chunks could not be indexed. Please retry the upload.":
      "This document could not be fully indexed. Please upload it again.",
    "The document is unavailable.":
      "This document is no longer available. Choose another document from your library.",
    "Choose a PDF file.": "Choose a PDF document (.pdf).",
  };
  if (Object.hasOwn(safeMessages, detail)) {
    return new ApiError(safeMessages[detail], "http", status);
  }
  if (status === 503)
    return new ApiError(
      "The service is temporarily unavailable. Please try again in a moment.",
      "http",
      status,
    );
  if (status === 413) {
    return new ApiError(
      "The server rejected this document because it is too large.",
      "http",
      status,
    );
  }
  if (status === 429) {
    return new ApiError(
      "The service is busy. Please wait a moment and try again.",
      "http",
      status,
    );
  }
  return new ApiError(
    `The server could not complete the request (${status}). Please try again.`,
    "http",
    status,
  );
}

async function request<T>(
  path: string,
  init: RequestInit,
  options: RequestOptions,
  timeoutMs: number,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  if (options.signal?.aborted) {
    throw new ApiError("The request was canceled.", "aborted");
  }

  const controller = new AbortController();
  let abortCode: "aborted" | "timeout" | undefined;
  const abort = (code: "aborted" | "timeout") => {
    if (controller.signal.aborted) return;
    abortCode = code;
    controller.abort();
  };
  const cancel = () => abort("aborted");
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => abort("timeout"), timeoutMs);

  try {
    const response = await fetch(`/api/${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) throw await httpError(response);
    const result = await read(response);
    // A cancellation may arrive while an already-buffered response is parsed.
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (abortCode === "timeout") {
      throw new ApiError(
        "The request took too long. Please try again.",
        "timeout",
      );
    }
    if (
      abortCode === "aborted" ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw new ApiError("The request was canceled.", "aborted");
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "Could not connect to Document AI. Check your connection and that the server is running, then try again.",
      "network",
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validDocument(value: unknown): value is DocumentInfo {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    typeof value.pages === "number" &&
    typeof value.chunks === "number" &&
    typeof value.status === "string" &&
    typeof value.created_at === "string"
  );
}
async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiError(
      "The server returned an unreadable response. Please try again.",
      "invalid-response",
    );
  }
}
function invalidResponse(): never {
  throw new ApiError(
    "The server returned an unexpected response. Please try again.",
    "invalid-response",
  );
}
export async function getSession(
  options: RequestOptions = {},
): Promise<SessionInfo> {
  return request(
    "session",
    { method: "GET" },
    options,
    30_000,
    async (response) => {
      const result = await json(response);
      if (
        !isRecord(result) ||
        typeof result.authenticated !== "boolean" ||
        !["session", "github"].includes(String(result.authMode))
      )
        return invalidResponse();
      if (
        result.authenticated &&
        (!isRecord(result.user) ||
          typeof result.user.id !== "string" ||
          !["session", "github"].includes(String(result.user.kind)))
      )
        return invalidResponse();
      return result as SessionInfo;
    },
  );
}
export async function listDocuments(
  options: RequestOptions = {},
): Promise<DocumentInfo[]> {
  return request(
    "documents",
    { method: "GET" },
    options,
    30_000,
    async (response) => {
      const result = await json(response);
      if (
        !isRecord(result) ||
        !Array.isArray(result.documents) ||
        !result.documents.every(validDocument)
      )
        return invalidResponse();
      return result.documents;
    },
  );
}
export async function uploadDocument(
  file: File,
  options: RequestOptions = {},
): Promise<DocumentInfo> {
  const validationError = validatePdf(file);
  if (validationError) throw new ApiError(validationError, "validation");
  const body = new FormData();
  body.append("file", file);
  return request(
    "documents",
    { method: "POST", body },
    options,
    180_000,
    async (response) => {
      const result = await json(response);
      if (!isRecord(result) || !validDocument(result.document))
        return invalidResponse();
      return result.document;
    },
  );
}
export async function deleteDocument(
  id: string,
  options: RequestOptions = {},
): Promise<void> {
  return request(
    `documents/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    options,
    30_000,
    async () => undefined,
  );
}

export async function transcribeAudio(
  audio: Blob,
  options: RequestOptions = {},
): Promise<string> {
  const body = new FormData();
  const extension = audio.type.startsWith("audio/mp4") ? "mp4" : "webm";
  body.append("file", audio, `question.${extension}`);
  try {
    return await request(
      "transcriptions",
      { method: "POST", body },
      options,
      70_000,
      async (response) => {
        const result = await json(response);
        if (
          !isRecord(result) ||
          typeof result.text !== "string" ||
          result.text.length > 8_000
        )
          return invalidResponse();
        return result.text.trim();
      },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 413)
      throw new ApiError(
        "This recording is too large. Try a shorter question.",
        "http",
        413,
      );
    throw error;
  }
}
