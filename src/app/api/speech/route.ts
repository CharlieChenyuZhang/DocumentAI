import { requirePrincipal } from "../../../lib/server/session";
import { agentRequest, proxyResult } from "../../../lib/server/agent-service";
import {
  assertSameOrigin,
  boundedBody,
  errorResponse,
  HttpError,
} from "../../../lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 75;

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

async function readAudio(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new HttpError(502, "No audio was returned. Please try again.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) {
        await reader.cancel();
        throw new HttpError(
          502,
          "The audio response was too large. Please try again.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size)
    throw new HttpError(502, "No audio was returned. Please try again.");
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requirePrincipal();
    if (
      request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      throw new HttpError(415, "Send text to read aloud as JSON.");
    const body = await boundedBody(request, 32 * 1024);
    let input: unknown;
    try {
      input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      );
    } catch {
      throw new HttpError(400, "Send valid text to read aloud.");
    }
    const text =
      input && typeof input === "object" && "text" in input
        ? input.text
        : undefined;
    if (typeof text !== "string" || !text.trim())
      throw new HttpError(400, "Add text to read aloud.");
    if (Array.from(text).length > 3000)
      throw new HttpError(
        413,
        "Read aloud accepts up to 3,000 characters per segment.",
      );
    const response = await agentRequest(
      user,
      "/speech",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
        signal: request.signal,
      },
      65_000,
    );
    if (!response.ok) return await proxyResult(response);
    if (
      response.headers.get("content-type")?.split(";", 1)[0] !== "audio/mpeg"
    ) {
      await response.body?.cancel();
      throw new HttpError(
        502,
        "Read aloud returned an invalid audio response. Please try again.",
      );
    }
    return new Response(await readAudio(response), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
