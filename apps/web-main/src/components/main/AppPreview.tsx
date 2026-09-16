'use client';

import { motion } from 'framer-motion';
import { Bell, Home, ShoppingBag, User, Navigation, Pause, RefreshCw, ArrowUpRight } from 'lucide-react';

/* ─── Shared: Bottom Navigation ─────────────────────────────────── */

const NAV_ITEMS = [
  { key: 'home', icon: Home, label: 'Home' },
  { key: 'orders', icon: ShoppingBag, label: 'Orders' },
  { key: 'profile', icon: User, label: 'Profile' },
] as const;

function BottomNav({ active }: { active: string }) {
  return (
    <nav className="mt-auto flex items-center justify-between border-t border-slate-200/60 bg-white px-6 py-2">
      {NAV_ITEMS.map(({ key, icon: Icon, label }) => {
        const isActive = key === active;
        return (
          <div key={key} className="flex flex-col items-center gap-1 py-0.5">
            <Icon
              className={`h-4 w-4 transition-colors duration-150 ${isActive ? 'text-brand' : 'text-slate-400'}`}
              strokeWidth={isActive ? 2.4 : 1.8}
            />
            <span
              className={`text-[9px] font-medium leading-none ${isActive ? 'text-brand' : 'text-slate-400'}`}
            >
              {label}
            </span>
            {isActive && <span className="mt-0.5 h-1 w-1 rounded-full bg-brand" />}
          </div>
        );
      })}
    </nav>
  );
}

/* ─── Dashboard Screen (Center) ─────────────────────────────────── */

function DashboardScreen() {
  return (
    <div className="w-full h-full bg-[#F8F7F4] flex flex-col text-slate-900 overflow-hidden select-none">
      {/* Header */}
      <header className="flex items-center justify-between px-5 pt-6 pb-4">
        <div>
          <p className="text-[11px] text-slate-500 font-medium">Good afternoon</p>
          <h2 className="mt-0.5 text-[17px] font-bold text-slate-900 tracking-tight leading-snug">
            Riya
          </h2>
        </div>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100">
          <Bell className="h-3.5 w-3.5 text-slate-400" strokeWidth={2} />
        </div>
      </header>

      {/* ── Primary summary card ── */}
      <div className="mx-4 rounded-2xl bg-white p-4 ring-1 ring-slate-200/60 shadow-[0_2px_12px_rgba(15,23,42,0.04)]">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-500 font-medium">Live order</span>
          <span className="flex items-center gap-1.5 text-[10px] font-medium text-emerald-600">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Preparing
          </span>
        </div>
        <p className="mt-2.5 text-[13px] font-semibold text-slate-900 leading-snug">
          Lunch — Dal Rice + Sabzi
        </p>
        <p className="mt-1 text-[11px] text-slate-500">Arriving 11:30 · Swad Kitchen</p>
        <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5">
          <span className="text-[10px] text-slate-400">Today</span>
          <span className="flex items-center gap-0.5 text-[11px] font-semibold text-brand">
            Track
            <ArrowUpRight className="h-2.5 w-2.5" strokeWidth={2.5} />
          </span>
        </div>
      </div>

      {/* ── Key metrics strip ── */}
      <div className="mx-4 mt-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200/60 shadow-[0_2px_12px_rgba(15,23,42,0.04)]">
        <div className="grid grid-cols-4 divide-x divide-slate-200/70 text-center">
          {[
            { value: '28', label: 'Meals' },
            { value: '14', label: 'Lunches' },
            { value: '14', label: 'Dinners' },
            { value: '₹120', label: 'Credits' },
          ].map((m) => (
            <div key={m.label} className="px-1.5">
              <p className="text-[14px] font-bold text-slate-900 leading-none">{m.value}</p>
              <p className="mt-1 text-[9px] text-slate-500 leading-none">{m.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Today's meals — rows, no nested cards ── */}
      <section className="mt-5 px-5">
        <h3 className="text-[11px] font-semibold text-slate-700">Today&apos;s meals</h3>
        <div className="mt-2.5 divide-y divide-slate-200/60">
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="text-[11px] font-medium text-slate-800">
                Lunch — Dal Rice + Sabzi
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Delivered</span>
          </div>
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
              <span className="text-[11px] font-medium text-slate-800">
                Dinner — Roti + Paneer
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Scheduled</span>
          </div>
        </div>
      </section>

      {/* ── Quick actions — flat row, no boxes ── */}
      <section className="mt-5 px-5">
        <h3 className="text-[11px] font-semibold text-slate-700">Quick actions</h3>
        <div className="mt-2 grid grid-cols-3 divide-x divide-slate-200/60">
          {[
            { icon: RefreshCw, label: 'Swap' },
            { icon: Pause, label: 'Pause' },
            { icon: Navigation, label: 'Track', active: true },
          ].map(({ icon: Icon, label, active }) => (
            <div key={label} className="flex flex-col items-center gap-1.5 py-2.5">
              <Icon
                className={`h-4 w-4 ${active ? 'text-brand' : 'text-slate-400'}`}
                strokeWidth={2}
              />
              <span
                className={`text-[10px] font-medium ${active ? 'text-brand' : 'text-slate-500'}`}
              >
                {label}
              </span>
            </div>
          ))}
        </div>
      </section>

      <BottomNav active="home" />
    </div>
  );
}

/* ─── Orders Screen (Left) ──────────────────────────────────────── */

function OrdersScreen() {
  return (
    <div className="w-full h-full bg-[#F8F7F4] flex flex-col text-slate-900 overflow-hidden select-none">
      <header className="px-5 pt-6 pb-4">
        <p className="text-[11px] text-slate-500 font-medium">Your orders</p>
        <h2 className="mt-0.5 text-[17px] font-bold text-slate-900 tracking-tight leading-snug">
          Subscription active
        </h2>
      </header>

      {/* Today */}
      <section className="px-5">
        <h3 className="text-[10px] font-semibold text-slate-500">Today</h3>
        <div className="mt-2.5 divide-y divide-slate-200/60">
          <div className="flex items-center justify-between py-2.5">
            <div className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="text-[11px] font-medium text-slate-800">
                Lunch — Dal Rice + Sabzi
              </span>
            </div>
            <span className="text-[10px] font-medium text-emerald-600">Delivered</span>
          </div>
          <div className="flex items-center justify-between py-2.5">
            <div className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
              <span className="text-[11px] font-medium text-slate-800">
                Dinner — Roti + Paneer
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Scheduled</span>
          </div>
        </div>
      </section>

      {/* Tomorrow */}
      <section className="mt-6 px-5">
        <h3 className="text-[10px] font-semibold text-slate-500">Tomorrow</h3>
        <div className="mt-2.5 divide-y divide-slate-200/60">
          <div className="flex items-center justify-between py-2.5">
            <div className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-300" />
              <span className="text-[11px] font-medium text-slate-800">
                Lunch — Veg Thali
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Scheduled</span>
          </div>
          <div className="flex items-center justify-between py-2.5">
            <div className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-300" />
              <span className="text-[11px] font-medium text-slate-800">
                Dinner — Egg Curry + Roti
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Scheduled</span>
          </div>
        </div>
      </section>

      <BottomNav active="orders" />
    </div>
  );
}

/* ─── Plan & Pricing Screen (Right) ─────────────────────────────── */

function PlanScreen() {
  return (
    <div className="w-full h-full bg-[#F8F7F4] flex flex-col text-slate-900 overflow-hidden select-none">
      <header className="px-5 pt-6 pb-4">
        <p className="text-[11px] text-slate-500 font-medium">Your plan</p>
        <h2 className="mt-0.5 text-[17px] font-bold text-slate-900 tracking-tight leading-snug">
          Weekly · Lunches &amp; dinners
        </h2>
      </header>

      {/* ── Thali price ── */}
      <div className="mx-4 rounded-2xl bg-white p-4 ring-1 ring-slate-200/60 shadow-[0_2px_12px_rgba(15,23,42,0.04)]">
        <p className="text-[10px] text-slate-500 font-medium">Thali price</p>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-[22px] font-bold text-brand leading-none">₹124</span>
          <span className="text-[11px] text-slate-500">per meal</span>
        </div>

        <div className="my-3 h-px bg-slate-100" />

        <div className="grid grid-cols-3 divide-x divide-slate-200/60 text-center">
          <div className="px-1">
            <p className="text-[9px] text-slate-500">Base</p>
            <p className="mt-0.5 text-[11px] font-semibold text-slate-800">₹80</p>
          </div>
          <div className="px-1">
            <p className="text-[9px] text-slate-500">Portion</p>
            <p className="mt-0.5 text-[11px] font-semibold text-slate-800">+₹44</p>
          </div>
          <div className="px-1">
            <p className="text-[9px] text-slate-500">Effective</p>
            <p className="mt-0.5 text-[11px] font-bold text-brand">₹124</p>
          </div>
        </div>

        <div className="my-3 h-px bg-slate-100" />
        <p className="text-[10px] text-slate-500">Rice · Dal · Roti · Sabji</p>
      </div>

      {/* ── Monthly calculation ── */}
      <div className="mx-4 mt-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200/60 shadow-[0_2px_12px_rgba(15,23,42,0.04)]">
        <p className="text-[10px] text-slate-500 font-medium">Monthly · 28 days</p>

        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-[11px] text-slate-600">Meals scheduled</span>
          <span className="text-[15px] font-bold text-slate-900">28</span>
        </div>

        <div className="mt-3 grid grid-cols-3 divide-x divide-slate-200/60 text-center">
          <div className="px-1">
            <p className="text-[9px] text-slate-500">Lunches</p>
            <p className="mt-0.5 text-[12px] font-semibold text-slate-800">14</p>
          </div>
          <div className="px-1">
            <p className="text-[9px] text-slate-500">Dinners</p>
            <p className="mt-0.5 text-[12px] font-semibold text-slate-800">14</p>
          </div>
          <div className="px-1">
            <p className="text-[9px] text-slate-500">Full days</p>
            <p className="mt-0.5 text-[12px] font-semibold text-slate-800">14</p>
          </div>
        </div>

        <p className="mt-3 text-[9px] text-slate-400">Need at least 30 meals</p>

        <div className="my-3 h-px bg-slate-100" />

        <div className="flex items-center justify-between">
          <span className="text-[11px] text-slate-600">Price per meal</span>
          <span className="text-[12px] font-semibold text-slate-800">₹124</span>
        </div>

        <div className="my-3 h-px bg-slate-100" />

        <div className="flex items-baseline justify-between">
          <span className="text-[10px] font-medium text-slate-500">Monthly investment</span>
          <span className="text-[20px] font-bold text-slate-900 leading-none">₹3,472</span>
        </div>
      </div>

      <BottomNav active="profile" />
    </div>
  );
}

/* ─── Phone Frame ───────────────────────────────────────────────── */

function PhoneMockup({
  children,
  rotate = 0,
  delay = 0,
  zIndex = 10,
}: {
  children: React.ReactNode;
  rotate?: number;
  delay?: number;
  zIndex?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 60, rotate: rotate - 4 }}
      whileInView={{ opacity: 1, y: 0, rotate }}
      viewport={{ once: true }}
      transition={{ duration: 0.8, delay, type: 'spring', stiffness: 80 }}
      style={{ zIndex }}
      className="relative h-[440px] w-[210px] shrink-0 overflow-hidden rounded-[2.5rem] border-[8px] border-slate-800 bg-slate-900 shadow-2xl"
    >
      {/* Notch */}
      <div className="absolute left-1/2 top-0 z-20 h-4 w-20 -translate-x-1/2 rounded-b-2xl bg-slate-900" />
      <div className="h-full w-full overflow-hidden">{children}</div>
    </motion.div>
  );
}

/* ─── Public Component ──────────────────────────────────────────── */

export function AppPreview() {
  return (
    <section className="relative overflow-hidden bg-slate-900 py-24 text-white">
      {/* Subtle background glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(230,138,0,0.15),transparent_60%)]"
      />

      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Section header */}
        <div className="mb-16 text-center">
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mb-3 text-sm font-bold uppercase tracking-widest text-amber-500"
          >
            App Preview
          </motion.p>
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="text-4xl font-black leading-tight md:text-5xl"
          >
            Manage your meals
            <br />
            from your pocket.
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 }}
            className="mx-auto mt-4 max-w-xl text-lg text-slate-400"
          >
            A fast, beautiful Progressive Web App. No downloads needed — just open
            it in your browser.
          </motion.p>
        </div>

        {/* ── Phone showcase ──
            < sm: single centered phone (zero overflow)
            sm+: three staggered phones, original composition restored */}
        <div className="flex min-h-[440px] items-end justify-center gap-4 pb-8 sm:gap-8">
          <div className="hidden sm:block">
            <PhoneMockup rotate={-6} delay={0} zIndex={10}>
              <OrdersScreen />
            </PhoneMockup>
          </div>

          <PhoneMockup rotate={0} delay={0.15} zIndex={20}>
            <DashboardScreen />
          </PhoneMockup>

          <div className="hidden sm:block">
            <PhoneMockup rotate={6} delay={0.3} zIndex={10}>
              <PlanScreen />
            </PhoneMockup>
          </div>
        </div>

        {/* Features row */}
        <div className="mx-auto mt-16 grid max-w-3xl gap-6 text-center sm:grid-cols-3">
          {[
            {
              label: 'No App Download',
              desc: 'Works right in your browser on any device.',
              icon: '⚡',
            },
            {
              label: 'Real-Time Tracking',
              desc: 'Watch your rider come to you live on the map.',
              icon: '📍',
            },
            {
              label: 'Swap & Pause',
              desc: 'Full control over your meals, any day.',
              icon: '🔄',
            },
          ].map((f, i) => (
            <motion.div
              key={f.label}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="rounded-2xl border border-white/10 bg-white/5 p-6"
            >
              <span className="mb-3 block text-3xl">{f.icon}</span>
              <h4 className="mb-1 font-black text-white">{f.label}</h4>
              <p className="text-sm text-slate-400">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}