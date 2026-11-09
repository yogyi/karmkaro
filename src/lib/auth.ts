import { PrismaAdapter } from "@auth/prisma-adapter";
import { CredentialsSignin } from "next-auth";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { headers } from "next/headers";
import { demoAuthUser, isDemoMode } from "./demo-mode";
import { prisma } from "./prisma";
import { verifyPassword } from "./password";
import { rateLimit } from "./rate-limit";
import { log } from "./log";

class InvalidLogin extends CredentialsSignin {
  code = "invalid";
}
class LockedLogin extends CredentialsSignin {
  code = "locked";
}
class UnverifiedLogin extends CredentialsSignin {
  code = "unverified";
}

async function clientIp() {
  const headerList = await headers();
  return headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || headerList.get("x-real-ip") || "local";
}

const providers: NextAuthConfig["providers"] = [
  Credentials({
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    authorize: async (credentials) => {
      const email = String(credentials?.email ?? "")
        .toLowerCase()
        .trim();
      const password = String(credentials?.password ?? "");
      if (!email || !password) throw new InvalidLogin();
      rateLimit(`login:${email}`, 12, 10 * 60 * 1000);

      if (isDemoMode()) {
        const demo = demoAuthUser(email, password);
        if (!demo) {
          log("warn", "Failed demo sign-in", { email });
          throw new InvalidLogin();
        }
        return demo;
      }

      const user = await prisma.user.findUnique({ where: { email } });
      const ip = await clientIp();
      if (!user?.passwordHash) {
        log("warn", "Failed sign-in", { email, ip });
        throw new InvalidLogin();
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) throw new LockedLogin();
      const matches = await verifyPassword(password, user.passwordHash);
      if (!matches) {
        const failedLogins = user.failedLogins + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLogins,
            lockedUntil: failedLogins >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null,
          },
        });
        const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
        if (membership) {
          await prisma.activityLog.create({
            data: {
              organizationId: membership.organizationId,
              actorId: user.id,
              action: "auth.login_failed",
              entityType: "user",
              entityId: user.id,
              ip,
            },
          });
        }
        throw new InvalidLogin();
      }
      if (!user.emailVerified) throw new UnverifiedLogin();
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null },
      });
      return { id: user.id, email: user.email, name: user.name, image: user.image };
    },
  }),
];

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET && !isDemoMode()) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      allowDangerousEmailAccountLinking: false,
    }),
  );
}

// Temporary fallback so first Vercel deploys can boot before secrets are added.
if (!process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = "karm-karo-temporary-auth-secret-replace-me";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: isDemoMode() ? undefined : PrismaAdapter(prisma),
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 },
  trustHost: true,
  pages: { signIn: "/login" },
  providers,
  callbacks: {
    async signIn({ user, account }) {
      if (isDemoMode()) return true;
      if (account?.provider === "google" && user.id) {
        await prisma.user.update({
          where: { id: user.id },
          data: { emailVerified: new Date() },
        });
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      if (isDemoMode() || !user.id) return;
      const membership = await prisma.membership.findFirst({ where: { userId: user.id, active: true } });
      if (!membership) return;
      const ip = await clientIp().catch(() => "local");
      await prisma.activityLog.create({
        data: {
          organizationId: membership.organizationId,
          actorId: user.id,
          action: "auth.login",
          entityType: "user",
          entityId: user.id,
          ip,
        },
      });
    },
  },
});
