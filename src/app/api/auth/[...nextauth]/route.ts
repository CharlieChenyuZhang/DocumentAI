import { handlers } from "@/auth";
import { errorResponse, HttpError } from "@/lib/server/http";
import type { NextRequest } from "next/server";

function authorizedHost(request: Request) {
  if (
    !process.env.APP_ORIGIN ||
    new URL(request.url).origin !== process.env.APP_ORIGIN
  ) {
    throw new HttpError(
      403,
      "Use the configured Document AI address to sign in.",
    );
  }
}
export async function GET(request: NextRequest) {
  try {
    authorizedHost(request);
    return await handlers.GET(request);
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    authorizedHost(request);
    return await handlers.POST(request);
  } catch (error) {
    return errorResponse(error);
  }
}
