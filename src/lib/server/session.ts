import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { HttpError } from "./http";

export type Principal = {
  id: string;
  name: string;
  kind: "session" | "github";
};
const COOKIE = "documentai_session";
const LIFETIME = 30 * 24 * 60 * 60;

export function authMode(): "session" | "github" {
  // Anonymous sessions must be explicitly enabled. Missing configuration never bypasses login.
  return process.env.AUTH_MODE === "session" ? "session" : "github";
}

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32)
    throw new HttpError(
      503,
      "Configure AUTH_SECRET before using the workspace.",
    );
  return value;
}

export function signSession(id: string, expires: number, key: string): string {
  const payload = `${id}.${expires}`;
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

export function verifySession(
  value: string,
  key: string,
  now = Date.now(),
): string | null {
  const [id, expires, signature, extra] = value.split(".");
  if (
    extra ||
    !/^[a-f0-9-]{36}$/.test(id || "") ||
    !/^\d{10}$/.test(expires || "") ||
    !signature
  )
    return null;
  const expiry = Number(expires);
  if (expiry * 1000 <= now || expiry * 1000 > now + (LIFETIME + 60) * 1000)
    return null;
  const expected = Buffer.from(signSession(id, expiry, key).split(".")[2]);
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length &&
    timingSafeEqual(expected, supplied)
    ? id
    : null;
}

export async function principal(create = false): Promise<Principal | null> {
  if (authMode() === "github") {
    if (!process.env.AUTH_GITHUB_ID || !process.env.AUTH_GITHUB_SECRET) {
      if (create) return null;
      throw new HttpError(
        503,
        "Configure GitHub sign-in to access your workspace.",
      );
    }
    secret();
    const { auth } = await import("../../auth");
    const session = await auth();
    if (!session?.user?.id?.startsWith("github:")) return null;
    return {
      id: session.user.id,
      name: session.user.name || "Your workspace",
      kind: "github",
    };
  }
  const key = secret();
  const store = await cookies();
  const value = store.get(COOKIE)?.value;
  let id = value ? verifySession(value, key) : null;
  if (!id && create) {
    id = randomUUID();
    store.set(
      COOKIE,
      signSession(id, Math.floor(Date.now() / 1000) + LIFETIME, key),
      {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: LIFETIME,
        secure: (process.env.APP_ORIGIN || "").startsWith("https://"),
      },
    );
  }
  return id
    ? { id: `session:${id}`, name: "This browser", kind: "session" }
    : null;
}

export async function requirePrincipal(): Promise<Principal> {
  const user = await principal();
  if (!user)
    throw new HttpError(401, "Sign in or reopen the workspace to continue.");
  return user;
}
