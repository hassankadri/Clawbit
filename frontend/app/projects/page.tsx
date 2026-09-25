export default function ProjectsPage() {
  return (
    <main className="min-h-screen bg-[#111111] text-white p-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold">Projects</h1>

        <p className="mt-2 text-sm text-zinc-400">
          Create and manage your Clawbit projects.
        </p>

        <div className="mt-8 rounded-xl border border-zinc-800 bg-[#171717] p-6">
          <p className="text-zinc-400">No projects yet.</p>

          <button className="mt-4 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-zinc-200">
            + Create project
          </button>
        </div>
      </div>
    </main>
  );
}