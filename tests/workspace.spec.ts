import { readFile, writeFile } from "node:fs/promises";
import {
  expect,
  test,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";

const appOrigin = `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT || 3107)}`;

const answer = {
  ragAnswer:
    "## Key finding\n\nThe document prioritizes **customer discovery** before scaling.\n\n- Interview customers.\n- Test your assumptions.",
  mcpAnswer:
    "External context supports a short feedback cycle. [Read the source](https://example.com/research).",
};

// A complete, one-page PDF keeps file selection and preview behavior realistic.
function minimalPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  let content = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

async function pdfFixture(testInfo: TestInfo, name = "customer-discovery.pdf") {
  const path = testInfo.outputPath(name);
  await writeFile(path, minimalPdf());
  return path;
}

async function attachPdf(page: Page, path: string) {
  await page.getByTestId("pdf-input").setInputFiles(path);
  await expect(
    page.getByText("Ready for questions", { exact: true }),
  ).toBeVisible();
}

async function ask(page: Page, question: string) {
  await page.getByRole("textbox", { name: "Your question" }).fill(question);
  await page
    .getByRole("button", { name: "Send question", exact: true })
    .click();
}

async function fulfillAnswer(route: Route, payload = answer) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(payload),
  });
}

async function mockBackend(
  page: Page,
  onChat?: (route: Route, question: string, attempt: number) => Promise<void>,
) {
  const uploads: string[] = [];
  const questions: string[] = [];
  await page.route("**/*", async (route) => {
    // Also block remote services when reusing a dev server with a different API URL.
    if (new URL(route.request().url()).origin === appOrigin) {
      await route.continue();
    } else {
      await route.abort();
    }
  });
  await page.route("http://localhost:5001/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/upload" && request.method() === "POST") {
      const multipart = request.postDataBuffer()?.toString() ?? "";
      const filename = multipart.match(/filename="([^"]+)"/)?.[1];
      expect(multipart).toContain('name="file"');
      // Chromium's intercepted postData omits file bytes, but retains the part metadata.
      expect(multipart).toContain("Content-Type: application/pdf");
      expect(filename).toBeTruthy();
      uploads.push(filename!);
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: `uploads/${filename} upload succeeded`,
      });
    } else if (url.pathname === "/chat" && request.method() === "GET") {
      const question = url.searchParams.get("question") ?? "";
      questions.push(question);
      if (onChat) await onChat(route, question, questions.length);
      else await fulfillAnswer(route);
    } else {
      // Never allow an unexpected request to reach the real AI service.
      await route.abort();
      throw new Error(
        `Unexpected backend request: ${request.method()} ${url.pathname}`,
      );
    }
  });
  return { uploads, questions };
}

test("starts empty and requires a document before sending", async ({
  page,
}, testInfo) => {
  const backend = await mockBackend(page);
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Good questions. Grounded answers." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export chat" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("desktop-empty.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: /See the big picture/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Your question" }),
  ).toHaveValue(/Summarize the key ideas/);
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeDisabled();
  await page.getByRole("textbox", { name: "Your question" }).press("Enter");
  expect(backend.uploads).toEqual([]);
  expect(backend.questions).toEqual([]);
});

test("rejects a non-PDF and an empty PDF before making requests", async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto("/");

  await page.getByTestId("pdf-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Meeting notes"),
  });
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Choose a PDF document",
  );
  await page.getByTestId("pdf-input").setInputFiles({
    name: "empty.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(0),
  });
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "This PDF is empty",
  );
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeDisabled();
  expect(backend.uploads).toEqual([]);
});

test("keeps working in memory when browser session storage is unavailable", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage access is blocked", "SecurityError");
      },
    });
  });
  const backend = await mockBackend(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Good questions. Grounded answers." }),
  ).toBeVisible();
  await attachPdf(page, await pdfFixture(testInfo));
  await ask(page, "Summarize without browser storage");
  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toContainText("customer discovery");
  await expect(
    page.getByRole("button", {
      name: "Summarize without browser storage",
      exact: true,
    }),
  ).toBeVisible();

  await page.reload();

  await expect(
    page.getByRole("heading", { name: "Good questions. Grounded answers." }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeDisabled();
  expect(backend.questions).toEqual(["Summarize without browser storage"]);
  expect(errors).toEqual([]);
});

test("uploads, displays both answer sources, and exports Markdown", async ({
  page,
}, testInfo) => {
  const backend = await mockBackend(page);
  const path = await pdfFixture(testInfo);
  await page.goto("/");
  await attachPdf(page, path);
  const question = "What matters most & why?";
  await ask(page, question);

  await expect(
    page
      .getByRole("region", { name: "Document answer", exact: true })
      .getByRole("list"),
  ).toHaveCSS("list-style-type", "disc");
  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toContainText("customer discovery");
  await expect(
    page.getByRole("region", { name: "Web answer", exact: true }),
  ).toContainText("short feedback cycle");
  await expect(
    page.getByRole("link", { name: "Read the source" }),
  ).toHaveAttribute("href", "https://example.com/research");
  expect(backend.questions).toEqual([question]);
  expect(backend.uploads).toEqual([
    "customer-discovery.pdf",
    "customer-discovery.pdf",
  ]);
  await page.screenshot({
    path: testInfo.outputPath("desktop-answered.png"),
    fullPage: true,
  });

  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export chat" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("document-ai-conversation.md");
  const markdown = await readFile((await download.path())!, "utf8");
  expect(markdown).toContain(`# ${question}`);
  expect(markdown).toContain("Document: customer-discovery.pdf");
  expect(markdown).toContain(`### Document answer\n\n${answer.ragAnswer}`);
  expect(markdown).toContain(`### Web answer\n\n${answer.mcpAnswer}`);
});

test("retries a failed answer without duplicating the question or discarding a new draft", async ({
  page,
}, testInfo) => {
  const backend = await mockBackend(page, async (route, _question, attempt) => {
    if (attempt === 1) {
      await route.fulfill({
        status: 503,
        body: "<html>Private server details</html>",
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    } else await fulfillAnswer(route);
  });
  await page.goto("/");
  await attachPdf(page, await pdfFixture(testInfo));
  await ask(page, "Explain the key finding");

  await expect(page.getByRole("main").getByRole("alert")).toContainText("503");
  await expect(page.getByRole("main").getByRole("alert")).not.toContainText(
    "Private server details",
  );
  const independentDraft = "What should I ask the team next?";
  await page
    .getByRole("textbox", { name: "Your question" })
    .fill(independentDraft);
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(
    page.getByRole("textbox", { name: "Your question" }),
  ).toHaveValue(independentDraft);
  expect(backend.questions).toEqual([
    "Explain the key finding",
    "Explain the key finding",
  ]);
  expect(backend.uploads).toHaveLength(3);
});

test("stops an in-flight answer, ignores its late result, and can retry successfully", async ({
  page,
}, testInfo) => {
  let releaseResponse!: () => void;
  let markRequested!: () => void;
  let markHandled!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const handled = new Promise<void>((resolve) => {
    markHandled = resolve;
  });
  const backend = await mockBackend(page, async (route, _question, attempt) => {
    if (attempt > 1) {
      await fulfillAnswer(route);
      return;
    }
    markRequested();
    await released;
    try {
      await fulfillAnswer(route, {
        ragAnswer: "A late answer that must not appear",
        mcpAnswer: "Late web response",
      });
    } catch {
      // Chromium may already have discarded the canceled network request.
    } finally {
      markHandled();
    }
  });
  await page.goto("/");
  await attachPdf(page, await pdfFixture(testInfo));
  await ask(page, "Analyze this document");
  await requested;
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(
    page.getByText("Response stopped", { exact: true }),
  ).toBeVisible();

  releaseResponse();
  await handled;

  await expect(
    page.getByText("A late answer that must not appear", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toContainText("customer discovery");
  await expect(
    page.getByRole("region", { name: "Web answer", exact: true }),
  ).toContainText("short feedback cycle");
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(
    page.getByText("A late answer that must not appear", { exact: true }),
  ).toHaveCount(0);
  expect(backend.questions).toEqual([
    "Analyze this document",
    "Analyze this document",
  ]);
});

test("keeps document replacement separate and reuploads the selected conversation's file", async ({
  page,
}, testInfo) => {
  const backend = await mockBackend(page);
  await page.goto("/");
  await attachPdf(page, await pdfFixture(testInfo, "first-report.pdf"));
  await ask(page, "Summarize the first report");
  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toBeVisible();

  await attachPdf(page, await pdfFixture(testInfo, "second-report.pdf"));
  await expect(page.getByRole("article")).toHaveCount(0);
  await ask(page, "Summarize the second report");
  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Summarize the first report", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Summarize the first report", level: 1 }),
  ).toBeVisible();
  await ask(page, "Give another detail from the first report");
  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toHaveCount(2);

  expect(backend.uploads).toEqual([
    "first-report.pdf",
    "first-report.pdf",
    "second-report.pdf",
    "second-report.pdf",
    "first-report.pdf",
  ]);
  expect(backend.questions).toEqual([
    "Summarize the first report",
    "Summarize the second report",
    "Give another detail from the first report",
  ]);
});

test("restores history after reload and requires reattaching the original PDF", async ({
  page,
}, testInfo) => {
  const backend = await mockBackend(page);
  const path = await pdfFixture(testInfo);
  await page.goto("/");
  await attachPdf(page, path);
  await ask(page, "Keep this conversation");
  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toBeVisible();
  await page.reload();

  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toContainText("customer discovery");
  await expect(
    page.getByRole("button", { name: "Reattach document", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Your question" })
    .fill("Continue the discussion");
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeDisabled();
  expect(backend.questions).toHaveLength(1);

  await attachPdf(page, path);
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(
    page.getByRole("region", { name: "Document answer", exact: true }),
  ).toHaveCount(2);
  expect(backend.questions).toEqual([
    "Keep this conversation",
    "Continue the discussion",
  ]);
});

test("provides accessible mobile drawers with trapped focus and Escape dismissal", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBackend(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Open navigation", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile-empty.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  const navigationTrigger = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  await navigationTrigger.click();
  const navigation = page.getByRole("dialog", {
    name: "Workspace navigation",
    exact: true,
  });
  await expect(navigation).toHaveAttribute("aria-modal", "true");
  await expect(
    navigation.getByRole("button", { name: "New conversation", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    navigation.getByRole("button", { name: "Getting started" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    navigation.getByRole("button", { name: "New conversation", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Your question" })
    .evaluate((element) => element.focus());
  await expect(
    navigation.getByRole("button", { name: "New conversation", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("mobile-navigation.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(navigation).toHaveCount(0);
  await expect(navigationTrigger).toBeFocused();

  await navigationTrigger.click();
  await expect(
    page.getByRole("button", { name: "New conversation", exact: true }),
  ).toBeInViewport();
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("button", { name: "Conversation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New conversation", exact: true }),
  ).not.toBeInViewport();

  const sourcesTrigger = page.getByRole("button", {
    name: "Show sources",
    exact: true,
  });
  await sourcesTrigger.click();
  const sources = page.getByRole("dialog", {
    name: "Sources and context",
    exact: true,
  });
  await expect(sources).toHaveAttribute("aria-modal", "true");
  await expect(
    sources.getByRole("button", { name: "Close sources panel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    sources.getByRole("button", { name: "How it works", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    sources.getByRole("button", { name: "Close sources panel", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Your question" })
    .evaluate((element) => element.focus());
  await expect(
    sources.getByRole("button", { name: "Close sources panel", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Sources & context" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Add a document", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("mobile-sources.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(sources).toHaveCount(0);
  await expect(sourcesTrigger).toBeFocused();

  await sourcesTrigger.click();
  await page
    .getByRole("button", { name: "Close sources panel", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sources & context" }),
  ).not.toBeInViewport();
});
