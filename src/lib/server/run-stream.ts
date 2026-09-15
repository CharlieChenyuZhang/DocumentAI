/** Keep the browser's stream lifetime tied to its exact upstream run. */
export function cancellableRunResponse(
  response: Response,
  signal: AbortSignal,
  stop: () => Promise<unknown>,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let finished = false;
  let stopped = false;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const cancel = async () => {
    if (finished || stopped) return;
    stopped = true;
    cleanup();
    await Promise.allSettled([stop(), reader.cancel()]);
  };
  const abort = () => {
    void cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (stopped || chunk.done) {
          finished = true;
          cleanup();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch {
        await cancel();
        controller.error(new Error("The response stream was interrupted."));
      }
    },
    cancel,
  });
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
}
