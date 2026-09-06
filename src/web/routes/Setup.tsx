import { type SubmitEvent, useState } from "react";

export function Setup() {
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
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
    else
      setError(
        "Could not create the administrator account. Passwords need 12+ characters.",
      );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Welcome to Homestacks</h1>
      <p className="text-slate-500">Create the administrator account.</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input
          name="name"
          placeholder="Name"
          required
          className="rounded border p-2"
        />
        <input
          name="email"
          type="email"
          placeholder="Email"
          required
          className="rounded border p-2"
        />
        <input
          name="password"
          type="password"
          placeholder="Password"
          required
          minLength={12}
          maxLength={128}
          className="rounded border p-2"
        />
        <button type="submit" className="rounded bg-slate-900 p-2 text-white">
          Create account
        </button>
      </form>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </main>
  );
}
