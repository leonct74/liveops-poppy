// P0: a contract-correct hello screen proving the poppy loads in the host. The real
// screens (Dashboard / Events / Remote config / Titles & SDK / Settings / Resources —
// IMPLEMENTATION.md §6) land in P4.

export function App() {
  return (
    <div className="lop-shell">
      <header className="lop-header">
        <h1>LiveOpsPoppy</h1>
        <p className="lop-tagline">
          Your game&apos;s LiveOps backend in your own AWS — remote config without review
          cycles, and player analytics nobody else can read.
        </p>
      </header>
      <main className="lop-card">
        <h2>Under construction</h2>
        <p>
          This is the P0 scaffold build. The backend stack (remote config + telemetry
          collector) deploys from P3; the dashboard and config editor arrive in P4.
        </p>
        <p className="lop-dim">No AWS resources are created by this build.</p>
      </main>
    </div>
  );
}
