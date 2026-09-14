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

export type ChatResponse = {
  ragAnswer: string;
  mcpAnswer: string;
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

function endpoint(path: string): string {
  const base =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:5001";
  return `${base.replace(/\/+$/, "")}/${path}`;
}

function httpError(status: number): ApiError {
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
    const response = await fetch(endpoint(path), {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) throw httpError(response.status);
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

export async function uploadDocument(
  file: File,
  options: RequestOptions = {},
): Promise<string> {
  const validationError = validatePdf(file);
  if (validationError) throw new ApiError(validationError, "validation");

  const body = new FormData();
  body.append("file", file);

  return request(
    "upload",
    { method: "POST", body },
    options,
    60_000,
    async (response) => {
      const result = await response.text();
      // Express sends this plain-text acknowledgement with a text/html content type.
      // Check the body instead so a proxy's HTML error page is never shown as success.
      if (!result.trim() || /^\s*</.test(result)) {
        throw new ApiError(
          "The server returned an unexpected upload response. Please try again.",
          "invalid-response",
        );
      }
      return result;
    },
  );
}

export async function askQuestion(
  question: string,
  options: RequestOptions = {},
): Promise<ChatResponse> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new ApiError("Enter a question about your document.", "validation");
  }

  const query = new URLSearchParams({ question: trimmedQuestion });
  return request(
    `chat?${query.toString()}`,
    {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    },
    options,
    120_000,
    async (response) => {
      let result: unknown;
      try {
        result = await response.json();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new ApiError(
          "The server returned an unreadable answer. Please try again.",
          "invalid-response",
        );
      }
      if (
        typeof result !== "object" ||
        result === null ||
        !("ragAnswer" in result) ||
        !("mcpAnswer" in result) ||
        typeof result.ragAnswer !== "string" ||
        typeof result.mcpAnswer !== "string"
      ) {
        throw new ApiError(
          "The server returned an incomplete answer. Please try again.",
          "invalid-response",
        );
      }
      return { ragAnswer: result.ragAnswer, mcpAnswer: result.mcpAnswer };
    },
  );
}
