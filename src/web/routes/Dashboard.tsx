import { useSession } from "../lib/auth-client.js";

export function Dashboard() {
  const { data } = useSession();
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-slate-500">Signed in as {data?.user.email}</p>
    </main>
  );
}
