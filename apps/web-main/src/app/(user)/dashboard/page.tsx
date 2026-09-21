'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { useVendorStore } from '@/store/vendorStore';
import { useUiStore } from '@/store/uiStore';
import { getApprovedVendors } from '@/lib/queries/users';
import { getCustomerAccessState } from '@dabzzo/shared-lib/subscriptionEntitlement';
import { getDocs, collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { VendorCard } from '@/components/vendor/VendorCard';
import { OffersCarousel } from '@/components/home/OffersCarousel';
import { SkeletonList } from '@/components/shared/Skeleton';
import { EmptyState } from '@/components/shared/EmptyState';
import type { SelectedLocation } from '@/components/shared/LocationSheet';
import type { Vendor } from '@/types';
import {
  Search,
  Bell,
  MapPin,
  Home,
  Briefcase,
  ChevronDown,
  X,
  RefreshCw,
  ChefHat,
} from 'lucide-react';

// Dynamic import for heavy LocationSheet to cut critical bundle weight & blocking time
const LocationSheet = dynamic(
  () => import('@/components/shared/LocationSheet').then((m) => m.LocationSheet),
  { ssr: false }
);

/* ─── Data ─────────────────────────────────────────────────────── */

const CATEGORIES = [
  { label: 'All',          value: 'all'   },
  { label: 'Home Style',   value: 'home'  },
  { label: 'North Indian', value: 'north' },
  { label: 'South Indian', value: 'south' },
  { label: 'Pure Veg',     value: 'veg'   },
  { label: 'Jain Menu',    value: 'jain'  },
] as const;

type CatValue = typeof CATEGORIES[number]['value'];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/* ─── Component ────────────────────────────────────────────────── */

export default function UserDashboard() {
  const router   = useRouter();
  const user     = useAuthStore((s) => s.user);
  const { vendors, setVendors, isStale } = useVendorStore();
  const addToast = useUiStore((s) => s.addToast);

  /* UI state */
  const [loading,        setLoading]        = useState(vendors.length === 0);
  const [search,         setSearch]          = useState('');
  const [category,       setCategory]        = useState<CatValue>('all');
  const [locationOpen,   setLocationOpen]    = useState(false);
  const [selectedLoc,    setSelectedLoc]     = useState<SelectedLocation | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /* Derived location pill text */
  const locationDisplay = selectedLoc
    ? (['Home', 'Work', 'Other'].includes(selectedLoc.label)
        ? selectedLoc.label
        : selectedLoc.locality || selectedLoc.city || 'My Location')
    : 'Near You';

  const LocationIcon =
    selectedLoc?.label === 'Home' ? Home
    : selectedLoc?.label === 'Work' ? Briefcase
    : MapPin;

  /* Live Database States */
  const [activeSubs, setActiveSubs] = useState<any[]>([]);
  const [activeDelivery, setActiveDelivery] = useState<any>(null);
  // Realtime mirror of the entitlement-filtered subscription list so the orders
  // listener can gate the live-delivery card without a stale closure.
  const activeSubsRef = useRef<any[]>([]);

  // Defer Firestore real-time subscriptions off critical rendering path
  useEffect(() => {
    if (!user) return;

    let unsubSubs = () => {};
    let unsubOrders = () => {};
    const unsubDeliveries = () => {};

    const timer = setTimeout(() => {
      // Listen to active subscriptions (entitlement-aware: expired-but-stored-
      // active subs are treated as EXPIRED and must not grant UI benefits).
      const qSubs = query(
        collection(db, 'subscriptions'),
        where('user_id', '==', user.id),
        where('status', '==', 'active')
      );
      unsubSubs = onSnapshot(qSubs, (snap) => {
        const access = getCustomerAccessState(
          snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
        );
        const validSubs = access.activeSubscriptions;
        activeSubsRef.current = validSubs;
        setActiveSubs(validSubs);
      });

      // Listen to today's active delivery order
      const ACTIVE_STATUSES = ['pending', 'preparing', 'ready', 'picked_up', 'out_for_delivery'];
      let ordersList: any[] = [];

      const updateActiveDelivery = () => {
        // A live delivery benefits only an ACTIVE subscription. If the sub has
        // expired (or none exists), the stored status may still say 'active' —
        // the entitlement check below guarantees the card never shows.
        if (activeSubsRef.current.length === 0) {
          setActiveDelivery(null);
          return;
        }
        const allActive = [...ordersList];
        if (allActive.length > 0) {
          const priorityOrder: Record<string, number> = {
            out_for_delivery: 1,
            picked_up: 2,
            ready: 3,
            preparing: 4,
            pending: 5,
          };
          allActive.sort(
            (a, b) => (priorityOrder[a.status] || 9) - (priorityOrder[b.status] || 9)
          );
          setActiveDelivery(allActive[0]);
        } else {
          setActiveDelivery(null);
        }
      };

      const qOrders = query(
        collection(db, 'orders'),
        where('user_id', '==', user.id),
        where('status', 'in', ACTIVE_STATUSES)
      );
      unsubOrders = onSnapshot(
        qOrders,
        (snap) => {
          // device-local date string is fine here: todayStr is only used to
          // decide which in-flight orders are "now", never any server decision
          const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
          ordersList = snap.docs
            .map((doc) => ({ id: doc.id, ...doc.data() }))
            .filter((order) => (order as any).date === todayStr);
          updateActiveDelivery();
        },
        (err) => console.warn('Dashboard orders listener warning:', err.message)
      );
    }, 100);

    return () => {
      clearTimeout(timer);
      unsubSubs();
      unsubOrders();
    };
  }, [user]);

  /* Vendor load */
  const loadVendors = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await getApprovedVendors();
      const countMap: Record<string, number> = {};
      try {
        const snap = await getDocs(
          query(collection(db, 'subscriptions'), where('status', '==', 'active'))
        );
        snap.forEach((d) => {
          const s = d.data();
          if (s.vendor_id) countMap[s.vendor_id] = (countMap[s.vendor_id] ?? 0) + 1;
        });
      } catch {
        /* subscription permission fallback */
      }
      setVendors(raw.map((v) => ({ ...v, subscriberCount: countMap[v.id] ?? 0 })));
    } catch {
      addToast('Failed to load kitchens', 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast, setVendors]);

  useEffect(() => {
    if (!isStale() && vendors.length > 0) return;
    void Promise.resolve().then(loadVendors);
  }, [isStale, loadVendors, vendors.length]);

  const filtered = useMemo(() => {
    let list = [...vendors];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (v) =>
          (v.kitchen_name ?? '').toLowerCase().includes(q) ||
          v.name.toLowerCase().includes(q) ||
          (v.cuisine_type ?? '').toLowerCase().includes(q)
      );
    }
    if (category !== 'all') {
      list = list.filter((v) => (v.cuisine_type ?? '').toLowerCase().includes(category));
    }
    return list;
  }, [vendors, search, category]);

  const handleLocationSelect = useCallback((loc: SelectedLocation) => {
    setSelectedLoc(loc);
  }, []);

  const firstName = user?.name?.split(' ')[0] ?? 'there';

  /* ─── Render ─────────────────────────────────────────────────── */
  return (
    <div className="min-h-dvh bg-[#F8FAFC]">
      <div className="animate-fade-in">
        {/* ════════════════════════════════════════
            HERO — Solid Orange with Crisp 2D Graphics
        ════════════════════════════════════════ */}
        <section
          className="relative rounded-b-[32px] overflow-hidden"
          style={{
            background: '#E68A00',
            paddingBottom: '32px',
            paddingTop: 'max(20px, env(safe-area-inset-top, 20px))',
          }}
        >
          {/* ── 2D Geometric Graphics & Vector Accents ── */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden select-none"
          >
            {/* Top-Right Large 2D Concentric Circles */}
            <div className="absolute -right-16 -top-16 w-72 h-72 rounded-full border-2 border-white/15" />
            <div className="absolute -right-8 -top-8 w-56 h-56 rounded-full bg-white/10" />
            <div className="absolute right-4 top-4 w-32 h-32 rounded-full border border-white/20" />

            {/* Bottom-Left 2D Circles & Arc */}
            <div className="absolute -left-12 bottom-6 w-48 h-48 rounded-full border-2 border-white/10" />
            <div className="absolute -left-6 bottom-12 w-32 h-32 rounded-full bg-white/8" />

            <div className="absolute right-12 bottom-20 opacity-20">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"
                  fill="white"
                />
              </svg>
            </div>
          </div>

          <div className="relative z-10 px-4 sm:px-5">
            {/* ── Top bar ── */}
            <div className="mb-3 flex items-center justify-between">
              {/* Location — opens dynamic sheet */}
              <button
                type="button"
                aria-label="Select delivery location"
                onClick={() => setLocationOpen(true)}
                className="flex items-center gap-1.5 rounded-full border border-white/30 bg-black/15 py-2 pl-3 pr-3.5 text-white transition-all duration-200 hover:bg-black/25 active:scale-95 backdrop-blur-md shadow-xs"
              >
                <LocationIcon
                  className="h-3.5 w-3.5 shrink-0 text-amber-200"
                  strokeWidth={2.5}
                />
                <span className="max-w-[130px] truncate text-[12.5px] font-bold leading-none">
                  {locationDisplay}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-70" strokeWidth={2.5} />
              </button>

              {/* Right — brand logo + notification bell */}
              <div className="flex items-center gap-3">
                <Link
                  href="/dashboard"
                  aria-label="Dabzzo home"
                  className="flex items-center transition-all duration-200 hover:opacity-90 active:scale-95 py-1"
                >
                  <Image
                    src="/logo-white.png"
                    alt="Dabzzo"
                    width={120}
                    height={28}
                    priority
                    unoptimized
                    className="h-7 w-auto object-contain drop-shadow-xs"
                  />
                </Link>

                <button
                  type="button"
                  aria-label="Notifications"
                  onClick={() => router.push('/support')}
                  className="relative flex h-[38px] w-[38px] items-center justify-center rounded-full border border-white/25 bg-black/15 text-white transition-all duration-200 hover:bg-black/25 active:scale-95 backdrop-blur-md shadow-xs"
                >
                  <Bell className="h-[17px] w-[17px]" strokeWidth={2.2} />
                  <span
                    aria-label="New notifications"
                    className="absolute right-2.5 top-2.5 h-[7px] w-[7px] rounded-full border-[1.5px] border-[#E68A00] bg-amber-200"
                  />
                </button>
              </div>
            </div>

            {/* ── Polished Hero Offers Carousel Card ── */}
            <div className="w-full mt-2">
              <OffersCarousel
                activeDelivery={activeDelivery}
                activeSubs={activeSubs}
                firstName={firstName}
                greetingText={greeting()}
              />
            </div>
          </div>
        </section>

        {/* ════════════════════════════════════════
            BODY — Clean Slate Canvas
        ════════════════════════════════════════ */}
        <div className="px-4 pb-8 sm:px-5">
          {/* ── Search Bar ── */}
          <div className="group relative -mt-6 mb-5">
            <div className="pointer-events-none absolute left-4.5 top-1/2 z-10 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-brand">
              <Search className="h-[18px] w-[18px]" strokeWidth={2.4} />
            </div>
            <input
              ref={searchRef}
              aria-label="Search vendors or cuisines"
              className="w-full rounded-2xl border border-slate-200/90 bg-white py-[14px] pl-12 pr-12 text-sm font-medium text-slate-900 outline-none transition-all duration-200 placeholder:text-slate-400 focus:-translate-y-0.5 focus:border-brand focus:shadow-[0_8px_24px_rgba(230,138,0,0.12)]"
              style={{ boxShadow: '0 4px 20px rgba(15,23,42,0.06)' }}
              placeholder="Explore kitchens or cuisines…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              {search ? (
                <button
                  aria-label="Clear search"
                  onClick={() => {
                    setSearch('');
                    searchRef.current?.focus();
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-xl border border-rose-200 bg-rose-50 text-rose-500 transition-all duration-200 hover:bg-rose-100 active:scale-95"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2.4} />
                </button>
              ) : null}
            </div>
          </div>

          {/* ── Cuisine Category Pills ── */}
          <div
            role="group"
            aria-label="Filter by cuisine"
            className="-mx-5 mb-5 flex gap-2 overflow-x-auto px-5 pb-1 scrollbar-none"
          >
            {CATEGORIES.map((cat) => {
              const active = category === cat.value;
              return (
                <button
                  key={cat.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setCategory(cat.value)}
                  className="shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200 active:scale-95 border"
                  style={
                    active
                      ? {
                          background: '#0F172A',
                          color: '#FFFFFF',
                          borderColor: '#0F172A',
                          boxShadow: '0 4px 12px rgba(15,23,42,0.12)',
                        }
                      : {
                          background: '#FFFFFF',
                          color: '#475569',
                          borderColor: '#E2E8F0',
                        }
                  }
                >
                  {cat.label}
                </button>
              );
            })}
          </div>

          {/* ── Vendor Section Header ── */}
          <div id="nearest-kitchens" className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-[18px] font-black tracking-tight text-slate-900">
                Nearest Kitchens
              </h2>
              <div
                className="mt-1 h-[3px] w-8 rounded-full"
                style={{ background: '#E68A00' }}
              />
            </div>
            {!loading && (
              <button
                type="button"
                aria-label="Refresh vendor list"
                onClick={() => void loadVendors()}
                className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500 transition-all duration-200 hover:border-brand hover:text-brand active:scale-95 shadow-2xs"
              >
                <RefreshCw className="h-3 w-3" strokeWidth={2.4} />
                {filtered.length} found
              </button>
            )}
          </div>

          {/* ── Vendor list ── */}
          {loading ? (
            <SkeletonList count={3} hasImage />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-orange-50 border border-orange-100">
                  <ChefHat className="w-9 h-9 text-brand stroke-[1.5]" />
                </div>
              }
              title="No kitchens found"
              description={
                search
                  ? `No kitchens matching "${search}". Try searching for another keyword.`
                  : 'Try selecting a different category above.'
              }
            />
          ) : (
            <div className="space-y-3.5">
              {filtered.map((v, i) => (
                <div
                  key={v.id}
                  className="animate-slide-up-soft"
                  style={{ animationDelay: `${Math.min(i, 5) * 50}ms` }}
                >
                  <VendorCard vendor={v} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Location bottom sheet (Loaded dynamically only when opened) ── */}
      {locationOpen && (
        <LocationSheet
          isOpen={locationOpen}
          onClose={() => setLocationOpen(false)}
          onSelect={handleLocationSelect}
        />
      )}
    </div>
  );
}
