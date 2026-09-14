import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";

const appOrigin = `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT || 3107)}`;
const answer =
  "## Key finding\n\nThe documents prioritize **customer discovery** before scaling.\n\n- Interview customers.\n- Test your assumptions.\n\nExternal context supports a short feedback cycle. [Read the source](https://example.com/research).";
type DocumentFixture = {
  id: string;
  name: string;
  size: number;
  pages: number;
  chunks: number;
  status: string;
  created_at: string;
};
type RunInput = {
  threadId: string;
  runId: string;
  messages: { id: string; role: string; content: string }[];
  state: { document_ids: string[]; web_enabled: boolean };
};
const documentFixture = (name: string, id = name): DocumentFixture => ({
  id,
  name,
  size: 100,
  pages: 2,
  chunks: 3,
  status: "ready",
  created_at: "2026-09-14T00:00:00Z",
});
const pdf = (name = "customer-discovery.pdf") => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n%%EOF"),
});
async function ask(page: Page, question: string) {
  await page.getByRole("textbox", { name: "Your question" }).fill(question);
  await page
    .getByRole("button", { name: "Send question", exact: true })
    .click();
}
function events(
  input: RunInput,
  options: { error?: boolean; text?: string } = {},
) {
  const messageId = `answer-${input.runId}`;
  const selected = input.state.document_ids;
  return [
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    {
      type: "STATE_SNAPSHOT",
      snapshot: {
        ...input.state,
        phase: "retrieving",
        citations: [],
        web_sources: [],
      },
    },
    {
      type: "TOOL_CALL_START",
      toolCallId: "retrieve-1",
      toolCallName: "retrieve_documents",
      parentMessageId: messageId,
    },
    {
      type: "TOOL_CALL_ARGS",
      toolCallId: "retrieve-1",
      delta: JSON.stringify({ query: "retrieve documents" }),
    },
    { type: "TOOL_CALL_END", toolCallId: "retrieve-1" },
    {
      type: "TOOL_CALL_RESULT",
      toolCallId: "retrieve-1",
      messageId: "tool-result-1",
      content: "Private tool result omitted from UI",
      role: "tool",
    },
    ...(options.error
      ? [{ type: "RUN_ERROR", message: "Private backend diagnostic" }]
      : [
          {
            type: "STATE_SNAPSHOT",
            snapshot: {
              ...input.state,
              phase: "generating",
              sources: [
                ...selected.map((id) => ({
                  kind: "document",
                  document_id: id,
                  document_name: id,
                  page: 1,
                })),
                ...(input.state.web_enabled
                  ? [
                      {
                        kind: "web",
                        title: "Research source",
                        url: "https://example.com/research",
                      },
                    ]
                  : []),
              ],
            },
          },
          { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: (options.text ?? answer).slice(0, 60),
          },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: (options.text ?? answer).slice(60),
          },
          { type: "TEXT_MESSAGE_END", messageId },
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ]),
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}
async function fulfillRun(
  route: Route,
  input: RunInput,
  options?: { error?: boolean; text?: string },
) {
  await route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: events(input, options),
  });
}
async function mockBackend(
  page: Page,
  options: {
    authenticated?: boolean;
    owner?: string;
    webSearch?: boolean | null;
    onRun?: (route: Route, input: RunInput, attempt: number) => Promise<void>;
    documents?: DocumentFixture[];
  } = {},
) {
  const uploads: string[] = [];
  const runs: RunInput[] = [];
  const stoppedRuns: string[] = [];
  let documents = options.documents ?? [];
  let owner = options.owner ?? "user-a";
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== appOrigin)
      await route.abort();
    else await route.continue();
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/session") {
      await route.fulfill({
        json: {
          authenticated: options.authenticated !== false,
          authMode: "session",
          configuration: {
            ready: true,
            ...(options.webSearch !== null
              ? { web_search: options.webSearch ?? true }
              : {}),
          },
          user:
            options.authenticated === false
              ? null
              : { id: owner, kind: "session" },
        },
      });
    } else if (path === "/api/documents" && request.method() === "GET")
      await route.fulfill({ json: { documents } });
    else if (path === "/api/documents" && request.method() === "POST") {
      const multipart = request.postDataBuffer()?.toString() ?? "";
      const name = multipart.match(/filename="([^"]+)"/)?.[1];
      expect(multipart).toContain('name="file"');
      expect(name).toBeTruthy();
      uploads.push(name!);
      const document = documentFixture(name!);
      documents = [...documents, document];
      await route.fulfill({ json: { document } });
    } else if (
      path.startsWith("/api/documents/") &&
      request.method() === "DELETE"
    ) {
      documents = documents.filter(
        (document) =>
          document.id !== decodeURIComponent(path.split("/").at(-1)!),
      );
      await route.fulfill({ status: 204 });
    } else if (path.startsWith("/api/copilotkit/agent/document_ai/stop/")) {
      const runId = request.headers()["x-documentai-run-id"];
      expect(runId).toBeTruthy();
      expect(runs.some((run) => run.runId === runId)).toBe(true);
      stoppedRuns.push(runId);
      await route.fulfill({ json: { success: true } });
    } else if (path === "/api/copilotkit/info") {
      await route.fulfill({
        json: {
          version: "1.71.1",
          agents: {
            document_ai: { description: "Document research assistant" },
          },
          actions: [],
        },
      });
    } else if (path === "/api/copilotkit/agent/document_ai/run") {
      const input = request.postDataJSON() as RunInput;
      runs.push(input);
      if (options.onRun) await options.onRun(route, input, runs.length);
      else await fulfillRun(route, input);
    } else {
      await route.abort();
      throw new Error(
        `Unexpected application request ${request.method()} ${path}`,
      );
    }
  });
  return {
    uploads,
    runs,
    stoppedRuns,
    setOwner(id: string) {
      owner = id;
      documents = [];
    },
  };
}

test("starts simply, hides development controls, and requires a selected PDF", async ({
  page,
}, testInfo) => {
  const backend = await mockBackend(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ask your documents" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeDisabled();
  await expect(page.getByText("Demo", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Summarize", exact: true }).click();
  await page.getByRole("textbox", { name: "Your question" }).press("Enter");
  expect(backend.runs).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("desktop-empty.png"),
    fullPage: true,
  });
});

test("requires authentication before loading private documents or agent state", async ({
  page,
}) => {
  await mockBackend(page, { authenticated: false });
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/"))
      apiRequests.push(new URL(request.url()).pathname);
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  expect(apiRequests.length).toBeGreaterThan(0);
  expect(new Set(apiRequests)).toEqual(new Set(["/api/session"]));
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("rejects non-PDF and empty files before making requests", async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ask your documents" }),
  ).toBeVisible();
  await page.getByTestId("pdf-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("notes"),
  });
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Choose a PDF",
  );
  await page.getByTestId("pdf-input").setInputFiles({
    name: "empty.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(0),
  });
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "This PDF is empty",
  );
  expect(backend.uploads).toEqual([]);
});

test("retrieves multiple persistent documents, renders AG-UI answer and citations, and exports", async ({
  page,
}, testInfo) => {
  const backend = await mockBackend(page);
  await page.goto("/");
  await page
    .getByTestId("pdf-input")
    .setInputFiles([pdf("first.pdf"), pdf("second.pdf")]);
  await expect(
    page.getByRole("button", { name: "2 documents selected", exact: true }),
  ).toBeVisible();
  await ask(page, "Compare the two reports");
  const response = page.getByRole("region", { name: "Answer", exact: true });
  await expect(response).toContainText("customer discovery");
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
  await expect(response.getByRole("list")).toHaveCSS("list-style-type", "disc");
  await page.getByText("Sources (3)", { exact: true }).click();
  await expect(
    page.getByText("first.pdf, page 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Research source" }),
  ).toHaveAttribute("href", "https://example.com/research");
  await expect(
    page.getByText("Private tool result omitted from UI"),
  ).toHaveCount(0);
  expect(backend.uploads).toEqual(["first.pdf", "second.pdf"]);
  expect(backend.runs[0].state).toMatchObject({
    document_ids: ["first.pdf", "second.pdf"],
    web_enabled: true,
  });
  await page.screenshot({
    path: testInfo.outputPath("desktop-answered.png"),
    fullPage: true,
  });
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export chat" }).click();
  const download = await downloaded;
  const markdown = await readFile((await download.path())!, "utf8");
  expect(markdown).toContain(answer);
  expect(markdown).toContain("Documents: first.pdf, second.pdf");
  await ask(page, "Another detail");
  await expect(page.getByRole("button", { name: "Copy answer" })).toHaveCount(
    2,
  );
  expect(backend.uploads).toHaveLength(2);
  expect(backend.runs[1].threadId).toBe(backend.runs[0].threadId);
});

test("persists selections and history for the same user without re-uploading", async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto("/");
  await page.getByTestId("pdf-input").setInputFiles(pdf());
  await ask(page, "Keep this conversation");
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Answer", exact: true }),
  ).toContainText("customer discovery");
  await ask(page, "Continue the discussion");
  await expect(page.getByRole("button", { name: "Copy answer" })).toHaveCount(
    2,
  );
  expect(backend.uploads).toHaveLength(1);
  expect(backend.runs[1].threadId).toBe(backend.runs[0].threadId);
});

test("keeps document selection and thread IDs separate between conversations", async ({
  page,
}) => {
  const backend = await mockBackend(page, {
    documents: [documentFixture("first.pdf"), documentFixture("second.pdf")],
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Show documents" }).click();
  await page.getByRole("checkbox", { name: /first.pdf/ }).check();
  await page.getByRole("button", { name: "Close documents" }).click();
  await ask(page, "First report");
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await page.getByRole("button", { name: "Show documents" }).click();
  await page.getByRole("checkbox", { name: /first.pdf/ }).uncheck();
  await page.getByRole("checkbox", { name: /second.pdf/ }).check();
  await page.getByRole("button", { name: "Close documents" }).click();
  await page.getByRole("checkbox", { name: "Include web search" }).uncheck();
  await ask(page, "Second report");
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
  await page.getByRole("button", { name: "First report", exact: true }).click();
  await ask(page, "Follow up on first");
  await expect(page.getByRole("button", { name: "Copy answer" })).toHaveCount(
    2,
  );
  expect(backend.runs.map((run) => run.state.document_ids)).toEqual([
    ["first.pdf"],
    ["second.pdf"],
    ["first.pdf"],
  ]);
  expect(backend.runs[1].state.web_enabled).toBe(false);
  expect(backend.runs[0].threadId).not.toBe(backend.runs[1].threadId);
  expect(backend.runs[0].threadId).toBe(backend.runs[2].threadId);
  expect(
    backend.runs[1].messages.filter((message) => message.role === "user"),
  ).toHaveLength(1);
});

test("never restores one account's history after the session changes", async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto("/");
  await page.getByTestId("pdf-input").setInputFiles(pdf());
  await ask(page, "Private question from account A");
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
  backend.setOwner("user-b");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Ask your documents" }),
  ).toBeVisible();
  await expect(page.getByText("Private question from account A")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "0 documents selected", exact: true }),
  ).toBeVisible();
});

test("retries an AG-UI run error without exposing diagnostics or discarding the draft", async ({
  page,
}) => {
  const backend = await mockBackend(page, {
    onRun: async (route, input, attempt) =>
      fulfillRun(route, input, { error: attempt === 1 }),
  });
  await page.goto("/");
  await page.getByTestId("pdf-input").setInputFiles(pdf());
  await ask(page, "Explain the key finding");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "could not finish",
  );
  await expect(
    page.getByRole("main").getByText("Private backend diagnostic"),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Your question" })
    .fill("Keep my new draft");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(
    page.getByRole("textbox", { name: "Your question" }),
  ).toHaveValue("Keep my new draft");
  expect(backend.uploads).toHaveLength(1);
  expect(backend.runs[0].messages.at(-1)?.id).not.toBe(
    backend.runs[1].messages.at(-1)?.id,
  );
});

test("stops a run, ignores its late result, and can retry", async ({
  page,
}) => {
  let release!: () => void;
  let requested!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const backend = await mockBackend(page, {
    onRun: async (route, input, attempt) => {
      if (attempt === 1) {
        requested();
        await released;
        try {
          await fulfillRun(route, input, { text: "Late canceled answer" });
        } catch {}
      } else await fulfillRun(route, input);
    },
  });
  await page.goto("/");
  await page.getByTestId("pdf-input").setInputFiles(pdf());
  await ask(page, "Analyze my documents");
  await seen;
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(
    page.getByText("Response stopped", { exact: true }),
  ).toBeVisible();
  release();
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
  await expect(
    page.getByText("Late canceled answer", { exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => backend.stoppedRuns).toContain(backend.runs[0].runId);
  expect(backend.stoppedRuns).not.toContain(backend.runs[1].runId);
});

test("removes a document from the library and retrieval scope", async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto("/");
  await page.getByTestId("pdf-input").setInputFiles(pdf("delete.pdf"));
  await expect(
    page.getByRole("button", { name: "1 document selected", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show documents" }).click();
  await page.getByRole("button", { name: "Delete delete.pdf" }).click();
  await expect(page.getByText("Your library is empty.")).toBeVisible();
  await page.getByRole("button", { name: "Close documents" }).click();
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeDisabled();
  expect(backend.runs).toEqual([]);
});

test("keeps working when browser storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
  });
  await mockBackend(page);
  await page.goto("/");
  await page.getByTestId("pdf-input").setInputFiles(pdf());
  await ask(page, "No browser storage");
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Ask your documents" }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("supports mobile navigation and document selection dialogs without overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBackend(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ask your documents" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile-empty.png"),
    fullPage: true,
  });
  const trigger = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  await trigger.click();
  const navigation = page.getByRole("dialog", {
    name: "Workspace navigation",
    exact: true,
  });
  await expect(
    navigation.getByRole("button", { name: "Close navigation" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    navigation.getByRole("button", { name: "Getting started" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Show documents" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Your documents",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Close documents" }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Add documents" }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("mobile-documents.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Show documents" }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("shows tool progress and partial text while the AG-UI stream is still open", async ({
  page,
}) => {
  const { createServer } = await import("node:http");
  let releaseText!: () => void;
  let releaseFinish!: () => void;
  const textReady = new Promise<void>((resolve) => {
    releaseText = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    releaseFinish = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": appOrigin,
        "Access-Control-Allow-Headers": "content-type,x-documentai-run-id",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Credentials": "true",
      });
      response.end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as RunInput;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Access-Control-Allow-Origin": appOrigin,
      "Access-Control-Allow-Credentials": "true",
      "Cache-Control": "no-cache",
    });
    const send = (event: unknown) =>
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
    send({
      type: "STATE_SNAPSHOT",
      snapshot: { ...input.state, phase: "retrieving", sources: [] },
    });
    await textReady;
    send({
      type: "STATE_SNAPSHOT",
      snapshot: { ...input.state, phase: "answering", sources: [] },
    });
    send({
      type: "TEXT_MESSAGE_START",
      messageId: "streaming-answer",
      role: "assistant",
    });
    send({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "streaming-answer",
      delta: "First streamed finding.",
    });
    await finished;
    send({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "streaming-answer",
      delta: " The final detail arrives later.",
    });
    send({ type: "TEXT_MESSAGE_END", messageId: "streaming-answer" });
    send({
      type: "RUN_FINISHED",
      threadId: input.threadId,
      runId: input.runId,
    });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server did not start");
  try {
    await mockBackend(page, {
      onRun: async (route) =>
        route.continue({ url: `http://127.0.0.1:${address.port}/run` }),
    });
    await page.goto("/");
    await page.getByTestId("pdf-input").setInputFiles(pdf());
    await ask(page, "Stream my answer");
    await expect(
      page.getByText("Searching your documents", { exact: true }),
    ).toBeVisible();
    releaseText();
    await expect(
      page.getByRole("region", { name: "Answer", exact: true }),
    ).toContainText("First streamed finding.");
    await expect(
      page.getByRole("button", { name: "Stop generating" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy answer" })).toHaveCount(
      0,
    );
    releaseFinish();
    await expect(
      page.getByRole("button", { name: "Copy answer" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Answer", exact: true }),
    ).toContainText("final detail arrives later");
  } finally {
    releaseText();
    releaseFinish();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const webSearch of [false, null]) {
  test(`document-only questions work when web search is ${webSearch === null ? "unreported" : "unavailable"}`, async ({
    page,
  }) => {
    const backend = await mockBackend(page, { webSearch });
    await page.goto("/");
    const toggle = page.getByRole("checkbox", {
      name: "Web search unavailable",
    });
    await expect(toggle).toBeDisabled();
    await expect(toggle).not.toBeChecked();
    await page.getByTestId("pdf-input").setInputFiles(pdf());
    await ask(page, "Summarize my document without web search");
    await expect(
      page.getByRole("button", { name: "Copy answer" }),
    ).toBeVisible();
    expect(backend.runs[0].state.web_enabled).toBe(false);
    expect(backend.runs[0].state.document_ids).toEqual([
      "customer-discovery.pdf",
    ]);
    await expect(page.getByText("Sources (1)", { exact: true })).toBeVisible();
  });
}
