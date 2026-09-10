export function Placeholder({ title }: { title: string }) {
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-slate-500">Built in a later phase.</p>
    </div>
  );
}
