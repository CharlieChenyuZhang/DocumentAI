import { expect, test, type Page, type Route } from "@playwright/test";

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

type VoiceTestWindow = Window & {
  __voiceTest: { tracks: MediaStreamTrack[]; calls: number };
};

async function prepareMicrophone(page: Page, denyFirstRequest = false) {
  await page.addInitScript((denyFirst) => {
    // Exercise native recording without a browser speech service or user audio.
    for (const name of ["SpeechRecognition", "webkitSpeechRecognition"])
      Object.defineProperty(window, name, {
        configurable: true,
        value: undefined,
      });
    const state = { tracks: [] as MediaStreamTrack[], calls: 0 };
    (window as unknown as VoiceTestWindow).__voiceTest = state;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      state.calls += 1;
      if (denyFirst && state.calls === 1)
        throw new DOMException("Permission denied", "NotAllowedError");
      const stream = await getUserMedia(constraints);
      state.tracks.push(...stream.getTracks());
      return stream;
    };
  }, denyFirstRequest);
}

async function mockWorkspace(
  page: Page,
  transcribe: (route: Route) => Promise<void>,
) {
  const runs: string[] = [];
  const transcriptions: string[] = [];
  const origin = `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT || 3107)}`;
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin) await route.abort();
    else await route.continue();
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({
        json: {
          authenticated: true,
          authMode: "session",
          configuration: {
            ready: true,
            vector_backend: "local",
            web_search: false,
          },
          user: { id: "voice-test-owner", kind: "session" },
        },
      });
    } else if (path === "/api/documents" && request.method() === "GET") {
      await route.fulfill({
        json: {
          documents: [
            {
              id: "voice-fixture",
              name: "voice-fixture.pdf",
              size: 100,
              pages: 1,
              chunks: 1,
              status: "ready",
              created_at: "2026-09-14T00:00:00Z",
            },
          ],
        },
      });
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
    } else if (path === "/api/transcriptions") {
      transcriptions.push(path);
      await transcribe(route);
    } else if (path === "/api/copilotkit/agent/document_ai/run") {
      runs.push(path);
      await route.fulfill({ status: 500, json: { error: "Unexpected run" } });
    } else {
      await route.abort();
      throw new Error(
        `Unexpected application request ${request.method()} ${path}`,
      );
    }
  });
  return { runs, transcriptions };
}

async function openWorkspace(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start voice input", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "0 documents selected" }).click();
  await page.getByRole("checkbox", { name: /voice-fixture\.pdf/ }).check();
  await page.getByRole("button", { name: "Close documents" }).click();
}

async function startRecording(page: Page) {
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop voice input", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as VoiceTestWindow).__voiceTest.tracks.map(
          (track) => track.readyState,
        ),
      ),
    )
    .toEqual(["live"]);
}

async function expectMicrophoneReleased(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as VoiceTestWindow).__voiceTest.tracks.map(
          (track) => track.readyState,
        ),
      ),
    )
    .toEqual(["ended"]);
}

test("records native browser audio and appends its transcription without sending", async ({
  page,
}) => {
  await prepareMicrophone(page);
  const backend = await mockWorkspace(page, async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    const body = request.postDataBuffer();
    expect(body).not.toBeNull();
    const form = await new Response(new Uint8Array(body!), {
      headers: { "Content-Type": request.headers()["content-type"] },
    }).formData();
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    const recording = file as File;
    expect(recording.type).toMatch(/^audio\/webm/);
    expect(recording.size).toBeGreaterThan(100);
    const bytes = new Uint8Array(await recording.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    await route.fulfill({ json: { text: "the main findings" } });
  });
  await openWorkspace(page);
  const draft = page.getByRole("textbox", { name: "Your question" });
  await draft.fill("Summarize");
  await startRecording(page);
  await page
    .getByRole("button", { name: "Stop voice input", exact: true })
    .click();
  await expect(draft).toHaveValue("Summarize the main findings");
  await expect(
    page.getByRole("button", { name: "Send question" }),
  ).toBeEnabled();
  await expectMicrophoneReleased(page);
  expect(backend.transcriptions).toHaveLength(1);
  expect(backend.runs).toEqual([]);
});

test("editing a draft cancels pending transcription and rejects a late result", async ({
  page,
}) => {
  await prepareMicrophone(page);
  let receiveRequest!: (route: Route) => void;
  const requestReceived = new Promise<Route>((resolve) => {
    receiveRequest = resolve;
  });
  let releaseResponse!: () => void;
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const backend = await mockWorkspace(page, async (route) => {
    receiveRequest(route);
    await responseReleased;
    await route.fulfill({ json: { text: "A stale transcription" } });
  });
  await openWorkspace(page);
  const draft = page.getByRole("textbox", { name: "Your question" });
  await draft.fill("Original question");
  await startRecording(page);
  await page
    .getByRole("button", { name: "Stop voice input", exact: true })
    .click();
  const pending = await requestReceived;
  await expect(
    page.getByRole("button", { name: "Cancel transcription" }),
  ).toBeVisible();
  const requestAborted = page.waitForEvent("requestfailed", {
    predicate: (request) => request === pending.request(),
  });
  await draft.fill("Keep my edited question");
  await requestAborted;
  releaseResponse();
  await expect(
    page.getByRole("button", { name: "Start voice input", exact: true }),
  ).toBeVisible();
  await expectMicrophoneReleased(page);
  await expect(draft).toHaveValue("Keep my edited question");
  expect(backend.transcriptions).toHaveLength(1);
  expect(backend.runs).toEqual([]);
});

test("recovers from microphone denial and releases recording when the user types", async ({
  page,
}) => {
  await prepareMicrophone(page, true);
  const backend = await mockWorkspace(page, async (route) => {
    await route.fulfill({ json: { text: "Unexpected transcription" } });
  });
  await openWorkspace(page);
  await page
    .getByRole("button", { name: "Start voice input", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    /microphone/i,
  );
  await startRecording(page);
  const draft = page.getByRole("textbox", { name: "Your question" });
  await draft.fill("I can still type my question");
  await expectMicrophoneReleased(page);
  await expect(
    page.getByRole("button", { name: "Start voice input", exact: true }),
  ).toBeVisible();
  await expect(draft).toHaveValue("I can still type my question");
  expect(backend.transcriptions).toEqual([]);
  expect(backend.runs).toEqual([]);
});
