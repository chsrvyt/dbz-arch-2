'use client';

import './globals.css';
import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error boundary caught:', error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-ivory text-slate-950 antialiased font-sans">
        <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-x-clip bg-ivory px-6 text-center">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-rose-500/10 blur-3xl" />
          </div>

          <div className="relative z-10 flex flex-col items-center">
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-50 ring-1 ring-rose-100">
              <AlertTriangle className="h-8 w-8 text-rose-500" strokeWidth={2.2} />
            </div>

            <p className="mb-3 rounded-full border border-rose-200 bg-rose-50 px-4 py-1 text-[11px] font-black uppercase tracking-[0.2em] text-rose-500">
              Something went wrong
            </p>

            <h1 className="text-2xl font-black tracking-tight sm:text-3xl">
              Dabzzo hit a snag
            </h1>

            <p className="mt-3 max-w-md text-sm font-medium leading-relaxed text-slate-500">
              An unexpected error interrupted the app. Try again below — if it
              keeps happening, please contact support.
            </p>

            <button
              type="button"
              onClick={() => reset()}
              className="mt-8 flex min-h-12 items-center justify-center gap-2 rounded-xl bg-brand px-8 py-3.5 text-sm font-black uppercase tracking-[0.1em] text-white shadow-[0_14px_28px_rgba(230,138,0,0.3)] transition-all hover:bg-brand-600 active:scale-[0.98]"
            >
              <RotateCcw className="h-4 w-4" />
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}