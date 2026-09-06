import { type SubmitEvent, useId, useState } from "react";
import { Button, Input } from "../components/ui/index.js";

export function Setup() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/onboarding/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        password: form.get("password"),
      }),
    });
    // A full page load, not navigate(): App gates routing on the ["status"]
    // query, whose cache still says initialised: false, so a client-side
    // navigation would be bounced straight back to /setup. Do not "fix" this
    // without also invalidating that query.
    if (res.ok) window.location.href = "/login";
    else {
      setBusy(false);
      setError(
        "Could not create the administrator account. Passwords need 12+ characters.",
      );
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold text-text">Welcome to Homestead</h1>
      <p className="text-muted">Create the administrator account.</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-sm font-medium text-text">
            Name
          </label>
          <Input
            id={nameId}
            name="name"
            placeholder="Name"
            autoComplete="name"
            required
          />
        </div>
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
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
          <p className="text-xs text-muted">At least 12 characters.</p>
        </div>
        <Button type="submit" variant="primary" loading={busy}>
          Create account
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
