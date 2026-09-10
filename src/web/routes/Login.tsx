import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@web/api/client";
import { useSetupStatus } from "@web/auth/useSession";
// SyntheticEvent, not FormEvent — @types/react 19 marks FormEvent @deprecated.
import { type SyntheticEvent, useState } from "react";

export function Login() {
  const setup = useSetupStatus();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsSetup = setup.data?.needsSetup === true;

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsSetup) {
        await apiFetch("/api/setup/admin", {
          method: "POST",
          body: JSON.stringify({ email, password, name }),
        });
      } else {
        await apiFetch("/api/auth/sign-in/email", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch {
      setError(needsSetup ? "Could not create the first admin." : "Incorrect email or password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Homestead</h1>
          <p className="text-sm text-slate-500">
            {needsSetup ? "Create the first administrator account." : "Sign in to continue."}
          </p>
        </div>

        {needsSetup && (
          <input
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        )}
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="username"
        />
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete={needsSetup ? "new-password" : "current-password"}
          minLength={needsSetup ? 12 : undefined}
        />

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {busy ? "Working…" : needsSetup ? "Create admin" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
