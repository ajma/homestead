import { type SubmitEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signIn } from "../lib/auth-client.js";

export function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (res.error) setError("Incorrect email or password.");
    else navigate("/");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input
          name="email"
          type="email"
          placeholder="Email"
          required
          className="rounded border-border bg-surface p-2 text-text"
        />
        <input
          name="password"
          type="password"
          placeholder="Password"
          required
          className="rounded border-border bg-surface p-2 text-text"
        />
        <button
          type="submit"
          className="rounded bg-accent p-2 text-accent-contrast"
        >
          Sign in
        </button>
      </form>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </main>
  );
}
