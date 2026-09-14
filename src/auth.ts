import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { handlers, auth } = NextAuth({
  // The auth route validates APP_ORIGIN before forwarding to Auth.js.
  trustHost: true,
  providers: [GitHub],
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  callbacks: {
    jwt({ token, account }) {
      if (account?.provider === "github") {
        token.sub = `github:${account.providerAccountId}`;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
