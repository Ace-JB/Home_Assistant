import type { FC, ReactNode } from 'react';

export const DemoPageShell: FC<{
  title: string;
  description: string;
  status: ReactNode;
  children: ReactNode;
}> = ({ title, description, status, children }) => (
  <main className="min-h-screen overflow-y-auto bg-slate-950 p-6 text-slate-100">
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex items-end justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-semibold text-white">{title}</h1>
          <p className="mt-1 text-sm text-slate-400">{description}</p>
        </div>
        <div className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs">
          {status}
        </div>
      </header>

      {children}
    </div>
  </main>
);
