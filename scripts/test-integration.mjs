import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";

// A real Next.js -> CopilotRuntime -> Python ADK/AG-UI chain. Only provider
// adapters in the explicitly selected test fixture are fake. No cloud calls.
const root = new URL("../", import.meta.url);
const base = "http://127.0.0.1:3108";
const token = "documentai-integration-test-token";
const children = [];
function start(command, args, env) {
  const process = spawn(command, args, {
    cwd: root,
    env: { ...globalThis.process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [process.stdout, process.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-8000);
    });
  children.push(process);
  return { process, logs: () => output };
}
async function ready(url, child, headers = {}) {
  for (let i = 0; i < 150; i++) {
    if (child.process.exitCode !== null)
      throw new Error(`Test service exited: ${child.logs()}`);
    try {
      if ((await fetch(url, { headers, signal: AbortSignal.timeout(1000) })).ok)
        return;
    } catch {}
    await delay(200);
  }
  throw new Error(`Test service did not start: ${child.logs()}`);
}
async function session() {
  const response = await fetch(`${base}/api/session`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const data = await response.json();
  assert.equal(data.configuration.ready, true);
  return { cookie, id: data.user.id };
}
function call(user, path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: { Cookie: user.cookie, Origin: base, ...options.headers },
    signal: AbortSignal.timeout(30_000),
  });
}
async function upload(user, name) {
  const form = new FormData();
  form.set(
    "file",
    new Blob(["%PDF-1.7\nSynthetic offline fixture"], {
      type: "application/pdf",
    }),
    name,
  );
  const response = await call(user, "/api/documents", {
    method: "POST",
    body: form,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).document;
}
function input(ids, question, run = crypto.randomUUID()) {
  return {
    threadId: "same-client-thread",
    runId: run,
    state: { document_ids: ids, web_enabled: false },
    messages: [{ id: crypto.randomUUID(), role: "user", content: question }],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}
function run(user, data, headers = {}) {
  return call(user, "/api/copilotkit/agent/document_ai/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
}

async function waitForPartial(response) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("Waiting for cancellation")) {
    const chunk = await reader.read();
    assert.ok(!chunk.done, text);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return reader;
}
async function finish(reader) {
  while (!(await reader.read()).done) {
    /* Drain terminal events. */
  }
}
async function stop(user, runId) {
  const response = await call(
    user,
    "/api/copilotkit/agent/document_ai/stop/same-client-thread",
    {
      method: "POST",
      headers: { "x-documentai-run-id": runId },
    },
  );
  assert.equal(response.status, 200);
  return (await response.json()).stopped;
}

let fixture, web;
try {
  fixture = start(
    ".venv/bin/python",
    [
      "-m",
      "uvicorn",
      "agent_service.tests.fixture_server:app",
      "--host",
      "127.0.0.1",
      "--port",
      "8011",
    ],
    {},
  );
  await ready("http://127.0.0.1:8011/health", fixture, {
    Authorization: `Bearer ${token}`,
    "x-documentai-owner": "test:probe",
  });
  web = start(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3108",
    ],
    {
      AUTH_MODE: "session",
      AUTH_SECRET: "integration-only-session-secret-at-least-32-characters",
      APP_ORIGIN: base,
      AGENT_SERVICE_URL: "http://127.0.0.1:8011",
      AGENT_SERVICE_TOKEN: token,
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
    },
  );
  await ready(base, web);
  const alice = await session(),
    bob = await session();
  assert.notEqual(alice.id, bob.id);
  const a = await upload(alice, "alice-private.pdf"),
    b = await upload(alice, "quarter-two.pdf");
  assert.equal(
    (await (await call(alice, "/api/documents")).json()).documents.length,
    2,
  );
  assert.equal(
    (await (await call(bob, "/api/documents")).json()).documents.length,
    0,
  );
  assert.equal((await fetch(`${base}/api/documents`)).status, 401);
  assert.equal(
    (
      await call(bob, `/api/documents/${a.id}`, {
        headers: { "x-documentai-owner": alice.id },
      })
    ).status,
    404,
  );
  assert.equal(
    (await call(bob, `/api/documents/${a.id}`, { method: "DELETE" })).status,
    404,
  );
  const pdf = await call(alice, `/api/documents/${a.id}`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-security-policy"), "sandbox");
  assert.equal((await call(alice, "/api/copilotkit/threads")).status, 404);
  assert.equal(
    (
      await call(alice, "/api/documents", {
        method: "POST",
        headers: { Origin: "https://other.example" },
      })
    ).status,
    403,
  );

  const response = await run(
    alice,
    input([a.id, b.id], "ALICE_PRIVATE_QUESTION: compare revenue"),
  );
  assert.equal(response.status, 200);
  const stream = await response.text();
  const events = stream
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.ok(
    events.some((event) => event.type === "RUN_FINISHED"),
    stream,
  );
  assert.ok(!events.some((event) => event.type === "RUN_ERROR"), stream);
  assert.equal(
    events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join(""),
    "Revenue increased by 20%. [D1]",
  );
  assert.ok(
    stream.includes("alice-private.pdf") && stream.includes("quarter-two.pdf"),
  );
  assert.ok(events.some((event) => event.type === "TOOL_CALL_START"));

  const reconnect = await call(
    bob,
    "/api/copilotkit/agent/document_ai/connect",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input([], "")),
    },
  );
  const replay = await reconnect.text();
  assert.ok(
    !replay.includes("alice-private.pdf") &&
      !replay.includes("ALICE_PRIVATE_QUESTION"),
  );
  const forbidden = await run(bob, input([a.id], "Get another user's file"), {
    "x-documentai-owner": alice.id,
  });
  const denied = await forbidden.text();
  assert.ok(
    !denied.includes("Revenue increased") &&
      !denied.includes("alice-private.pdf"),
  );
  assert.ok(denied.includes("RUN_ERROR") || !forbidden.ok, denied);

  const firstRun = crypto.randomUUID();
  const firstReader = await waitForPartial(
    await run(alice, input([a.id], "WAIT_FOR_CANCEL", firstRun)),
  );
  assert.equal(await stop(bob, firstRun), false);
  assert.equal(await stop(alice, crypto.randomUUID()), false);
  assert.equal(await stop(alice, firstRun), true);
  await finish(firstReader);
  const secondRun = crypto.randomUUID();
  const secondReader = await waitForPartial(
    await run(alice, input([a.id], "WAIT_FOR_CANCEL", secondRun)),
  );
  assert.equal(
    await stop(alice, firstRun),
    false,
    "A delayed stop must not cancel the retry",
  );
  assert.equal(await stop(alice, secondRun), true);
  await finish(secondReader);
  let cancelled = 0;
  for (let attempt = 0; attempt < 30 && cancelled < 2; attempt++) {
    const observation = await fetch("http://127.0.0.1:8011/test-observations", {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-documentai-owner": alice.id,
      },
    });
    cancelled = (await observation.json()).cancelled_runs;
    if (cancelled < 2) await delay(100);
  }
  assert.equal(
    cancelled,
    2,
    "Both stopped model producers must actually be cancelled",
  );
  assert.equal(
    (await call(alice, `/api/documents/${a.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal((await call(alice, `/api/documents/${a.id}`)).status, 404);
  console.log(
    "Integration passed: real Next.js/CopilotKit/ADK streaming, multi-document sources, owner isolation, spoof rejection, private reconnect, exact-run stop/retry, producer cancellation, deletion, and origin checks.",
  );
} catch (error) {
  console.error(error);
  if (web) console.error(web.logs());
  if (fixture) console.error(fixture.logs());
  process.exitCode = 1;
} finally {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), delay(3000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  );
}
