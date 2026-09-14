// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { signSession, verifySession } from "./session";
import { assertSameOrigin, boundedBody } from "./http";
import { ScopedRunner, scopedThread } from "./scoped-runner";
import { AgentRunner } from "@copilotkit/runtime/v2";
import { EMPTY } from "rxjs";
import { HttpAgent } from "@ag-ui/client";
import { cancellableRunResponse } from "./run-stream";

describe("server identity", () => {
  const key = "a private key with at least 32 characters";
  it("rejects a changed owner, bad signature, expired cookie, and wrong secret", () => {
    const id = randomUUID();
    const now = Date.now();
    const signed = signSession(id, Math.floor(now / 1000) + 3600, key);
    expect(verifySession(signed, key, now)).toBe(id);
    expect(
      verifySession(signed.replace(id, randomUUID()), key, now),
    ).toBeNull();
    expect(verifySession(`${signed}bad`, key, now)).toBeNull();
    expect(verifySession(signed, "another secret", now)).toBeNull();
    expect(verifySession(signed, key, now + 7200 * 1000)).toBeNull();
  });
  it("rejects cross-origin mutations", () => {
    vi.stubEnv("APP_ORIGIN", "https://documents.example");
    expect(() =>
      assertSameOrigin(
        new Request("https://documents.example/api/documents", {
          headers: { origin: "https://attacker.example" },
        }),
      ),
    ).toThrow();
    expect(() =>
      assertSameOrigin(
        new Request("https://documents.example/api/documents", {
          headers: { origin: "https://documents.example" },
        }),
      ),
    ).not.toThrow();
    vi.unstubAllEnvs();
  });
  it("enforces actual body length when content-length is false", async () => {
    await expect(
      boundedBody(
        new Request("http://localhost", {
          method: "POST",
          body: "123456",
          headers: { "content-length": "1" },
        }),
        5,
      ),
    ).rejects.toThrow("too large");
  });
});

describe("CopilotKit thread isolation", () => {
  it("scopes run, reconnect, status, and stop to the authenticated owner", async () => {
    const delegate = {
      run: vi.fn(() => EMPTY),
      connect: vi.fn(() => EMPTY),
      stop: vi.fn(async () => true),
      isRunning: vi.fn(async () => false),
    } as unknown as AgentRunner;
    const alice = new ScopedRunner("github:alice", delegate);
    const bob = new ScopedRunner("github:bob", delegate);
    const input = {
      threadId: "same-thread",
      runId: "run",
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    alice.run({
      threadId: input.threadId,
      input,
      agent: new HttpAgent({ url: "http://localhost/run" }),
    });
    bob.connect({ threadId: input.threadId });
    await bob.stop({ threadId: input.threadId });
    await bob.isRunning({ threadId: input.threadId });
    const a = scopedThread("github:alice", input.threadId);
    const b = scopedThread("github:bob", input.threadId);
    expect(a).not.toBe(b);
    expect(delegate.run).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: a, input }),
    );
    expect(delegate.connect).toHaveBeenCalledWith({ threadId: b });
    expect(delegate.stop).toHaveBeenCalledWith({ threadId: b });
    expect(delegate.isRunning).toHaveBeenCalledWith({ threadId: b });
    expect(alice.ɵsupportsLocalThreadEndpoints).not.toBe(true);
  });
});

describe("stream cancellation", () => {
  it("stops the upstream run when the browser aborts its request", async () => {
    const controller = new AbortController();
    const stop = vi.fn(async () => true);
    const upstreamCancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1]));
      },
      cancel: upstreamCancel,
    });
    const response = cancellableRunResponse(
      new Response(source),
      controller.signal,
      stop,
    );
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    expect((await reader.read()).done).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(upstreamCancel).toHaveBeenCalledOnce();
  });
  it("does not stop a completed run when the request later closes", async () => {
    const controller = new AbortController();
    const stop = vi.fn(async () => true);
    const response = cancellableRunResponse(
      new Response("complete"),
      controller.signal,
      stop,
    );
    expect(await response.text()).toBe("complete");
    controller.abort();
    expect(stop).not.toHaveBeenCalled();
  });
});
