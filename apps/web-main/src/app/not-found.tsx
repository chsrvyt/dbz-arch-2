import Link from 'next/link';
import Image from 'next/image';
import { UtensilsCrossed } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-x-clip bg-ivory px-6 text-center text-slate-950">
      {/* Soft brand glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -top-32 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-brand/15 blur-3xl" />
        <div className="absolute right-0 top-1/3 h-40 w-40 rounded-full bg-brand-secondary/10 blur-2xl" />
      </div>

      <div className="relative z-10 flex flex-col items-center">
        <Link
          href="/"
          aria-label="Dabzzo home"
          className="mb-10 flex items-center gap-2 rounded-2xl border border-slate-200/80 bg-white px-5 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.06)] transition-all hover:shadow-[0_12px_32px_rgba(15,23,42,0.1)] active:scale-95"
        >
          <Image
            src="/logo.png"
            alt="Dabzzo"
            width={96}
            height={22}
            unoptimized
            priority
            className="h-5 w-auto object-contain"
          />
        </Link>

        <p className="mb-3 rounded-full border border-brand/20 bg-brand/10 px-4 py-1 text-[11px] font-black uppercase tracking-[0.2em] text-brand-700">
          Error 404
        </p>

        <h1 className="text-7xl font-black leading-none tracking-tight sm:text-8xl">
          <span className="text-brand">4</span>0<span className="text-brand">4</span>
        </h1>

        <h2 className="mt-4 text-xl font-black tracking-tight sm:text-2xl">
          This page went for lunch
        </h2>

        <p className="mt-3 max-w-md text-sm font-medium leading-relaxed text-slate-500">
          The page you&apos;re looking for doesn&apos;t exist, was moved, or is
          still in the kitchen being prepared.
        </p>

        <div className="mt-8 flex w-full max-w-xs flex-col gap-3 sm:flex-row sm:max-w-none">
          <Link
            href="/"
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand px-6 py-3.5 text-sm font-black uppercase tracking-[0.1em] text-white shadow-[0_14px_28px_rgba(230,138,0,0.3)] transition-all hover:bg-brand-600 active:scale-[0.98]"
          >
            <UtensilsCrossed className="h-4 w-4" />
            Back to Dabzzo
          </Link>
          <Link
            href="/dashboard"
            className="flex min-h-12 w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-6 py-3.5 text-sm font-black uppercase tracking-[0.1em] text-slate-700 transition-all hover:border-slate-300 hover:bg-slate-50 active:scale-[0.98]"
          >
            Go to Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}