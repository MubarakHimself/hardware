export default function DashboardLoading() {
  return (
    <div aria-label="Loading page" role="status" className="animate-pulse space-y-6 motion-reduce:animate-none">
      <div><div className="h-3 w-28 rounded bg-[var(--surface-sunken)]" /><div className="mt-3 h-8 w-64 rounded-lg bg-[var(--surface-sunken)]" /><div className="mt-3 h-4 max-w-xl rounded bg-[var(--surface-sunken)]" /></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-32 rounded-xl border border-[var(--line)] bg-[var(--surface)]" />)}</div>
      <div className="h-96 rounded-xl border border-[var(--line)] bg-[var(--surface)]" />
      <span className="sr-only">Loading Hardware</span>
    </div>
  );
}
