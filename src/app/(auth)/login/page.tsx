"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Suspense, useState } from "react";
import { Mark, Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

const demos = [
  ["Aanya Sharma", "aanya.sharma@karmkaro.dev", "Super admin"],
  ["Arjun Mehta", "arjun.mehta@karmkaro.dev", "Admin"],
  ["Rahul Verma", "rahul.verma@karmkaro.dev", "Employee"],
];

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(params.get("verified") ? "" : "");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const result = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (result?.error) {
      const code = (result as { code?: string }).code;
      setError(
        code === "locked"
          ? "This account is locked for 15 minutes."
          : code === "unverified"
            ? "Verify your email first."
            : "Those details did not match.",
      );
      return;
    }
    router.push("/today");
    router.refresh();
  }

  return (
    <main className="grid min-h-dvh md:grid-cols-2">
      <section className="relative hidden overflow-hidden karm-ink-panel p-10 text-[#f4f3ef] md:flex md:flex-col md:justify-between">
        <div className="absolute inset-0 karm-grain opacity-[0.08]" aria-hidden />
        <div className="relative">
          <div className="flex items-center gap-2.5">
            <Mark />
            <Wordmark light />
          </div>
          <h1 className="mt-14 max-w-md font-display text-5xl font-extrabold leading-[1.05] tracking-tight text-balance">
            Sign in and pick up the thread.
          </h1>
          <p className="mt-5 max-w-sm text-pretty text-[#f4f3ef]/70">
            Your desk remembers who owns what — across Hindi, Hinglish, and English.
          </p>
        </div>
        <p className="relative text-sm text-[#f4f3ef]/45">Indus Collective demo ready</p>
      </section>

      <section className="relative flex items-center justify-center karm-atmosphere p-6">
        <div className="absolute inset-0 karm-grain" aria-hidden />
        <form onSubmit={submit} className="relative w-full max-w-sm space-y-4 rounded-2xl border border-border/80 bg-white/90 p-6 shadow-[0_20px_50px_-30px_rgb(16_16_31/0.35)] backdrop-blur">
          <div className="md:hidden">
            <Wordmark />
          </div>
          <div>
            <h2 className="font-display text-3xl font-bold tracking-tight text-balance">Sign in</h2>
            <p className="mt-1 text-sm text-muted-foreground">Use your workspace email.</p>
          </div>
          {params.get("verified") && <p className="text-sm text-emerald-700">Email confirmed. You can sign in.</p>}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button className="w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          {process.env.NEXT_PUBLIC_DEMO !== "0" && (
            <div className="space-y-1.5 rounded-xl bg-secondary/70 p-3 text-sm">
              <p className="font-medium text-foreground/80">Demo password: KarmKaro#2026</p>
              <p className="text-xs text-muted-foreground">Tap a name to fill the form — works without a database.</p>
              {demos.map(([name, mail, role]) => (
                <button
                  type="button"
                  key={mail}
                  className="block w-full cursor-pointer rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-white"
                  onClick={() => {
                    setEmail(mail);
                    setPassword("KarmKaro#2026");
                  }}
                >
                  <span className="font-medium">{name}</span>
                  <span className="text-muted-foreground"> · {role}</span>
                </button>
              ))}
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            <Link className="font-medium text-foreground underline-offset-4 hover:underline" href="/forgot">
              Forgot password
            </Link>
            {" · "}
            <Link className="font-medium text-foreground underline-offset-4 hover:underline" href="/signup">
              Create a workspace
            </Link>
          </p>
          {process.env.NEXT_PUBLIC_GOOGLE === "1" && (
            <Button type="button" variant="outline" className="w-full" onClick={() => signIn("google", { callbackUrl: "/today" })}>
              Continue with Google
            </Button>
          )}
        </form>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
