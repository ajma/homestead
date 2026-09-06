import { type SubmitEvent, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input } from "../components/ui/index.js";
import { signIn } from "../lib/auth-client.js";

export function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailId = useId();
  const passwordId = useId();

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const res = await signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setBusy(false);
    if (res.error) setError("Incorrect email or password.");
    else navigate("/");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold text-text">Sign in</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {/* A real label, not a placeholder standing in for one: a placeholder
            disappears the moment the field has content, and it is the first
            screen of the app. */}
        <div className="flex flex-col gap-1">
          <label htmlFor={emailId} className="text-sm font-medium text-text">
            Email
          </label>
          <Input
            id={emailId}
            name="email"
            type="email"
            placeholder="Email"
            autoComplete="email"
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={passwordId} className="text-sm font-medium text-text">
            Password
          </label>
          <Input
            id={passwordId}
            name="password"
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            required
          />
        </div>
        <Button type="submit" variant="primary" loading={busy}>
          Sign in
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </main>
  );
}
