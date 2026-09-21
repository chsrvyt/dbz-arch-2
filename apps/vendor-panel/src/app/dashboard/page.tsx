'use client';

import { useState, useMemo, useEffect } from 'react';
import { httpsCallable } from 'firebase/functions';
import toast from 'react-hot-toast';
import {
  Users, CheckCircle, ChefHat, PackageCheck, Phone,
  CalendarClock, IndianRupee, UtensilsCrossed,
  Star, MapPin, Sparkles, Activity,
  AlertTriangle, Tag, Check, Pencil,
  Calendar, Truck, X, Loader2
} from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useVendorData } from '@/components/vendor/VendorDataProvider';
import type { BatchStatus } from '@/types';
import { db, functions } from '@/lib/firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { TodayMenuCard } from '@/components/vendor/TodayMenuCard';
import { MealRatesCard } from '@/components/vendor/MealRatesCard';
import { UpdateVendorLocationModal } from '@/components/vendor/UpdateVendorLocationModal';
import { PendingVerificationScreen } from '@/components/shared/PendingVerificationScreen';
import { generateBoxTag } from '@/lib/boxTag';
import { getBoxManifest } from '@/lib/mealManifest';
import { VegIcon, NonVegIcon, DietaryBadge } from '@/components/shared/DietaryIcon';
import { getErrorMessage } from '@dabzzo/shared-lib/errors';
import { getVendorPrepSummary, getVendorPrepDetails } from '@dabzzo/shared-queries/delivery';

type ActiveTab = 'overview' | 'tags' | 'menu' | 'subscribers' | 'rates';

const BATCH_STATUS_DISPLAY: Record<BatchStatus, { label: string; color: string; bg: string; border: string }> = {
  pending:            { label: 'Pending',           color: 'text-slate-600',  bg: 'bg-slate-50',    border: 'border-slate-200' },
  notified:           { label: 'Awaiting Prep',     color: 'text-amber-700',  bg: 'bg-amber-50',    border: 'border-amber-200' },
  preparing:          { label: 'In Kitchen Oven',   color: 'text-blue-700',   bg: 'bg-blue-50',     border: 'border-blue-200' },
  ready:              { label: 'Ready for Dispatch',color: 'text-emerald-700',bg: 'bg-emerald-50', border: 'border-emerald-200' },
  pickup_in_progress: { label: 'Rider Handover',    color: 'text-purple-700', bg: 'bg-purple-50',  border: 'border-purple-200' },
  picked_up:          { label: 'Out for Delivery',  color: 'text-blue-700',   bg: 'bg-blue-50',     border: 'border-blue-200' },
  completed:          { label: 'Delivered',         color: 'text-emerald-700',bg: 'bg-emerald-50',  border: 'border-emerald-200' },
};

function formatBatchTitle(slot: string) {
  const s = (slot || "").toLowerCase().trim();
  if (s === "11am" || s === "lunch" || s === "1pm") {
    return {
      title: "LUNCH PREP BATCH",
      deliveryTime: "1:00 PM Delivery",
      timeSlot: "11:00 AM Prep • 1:00 PM Delivery"
    };
  }
  if (s === "8pm" || s === "dinner") {
    return {
      title: "DINNER PREP BATCH",
      deliveryTime: "8:00 PM Delivery",
      timeSlot: "7:30 PM Prep • 8:00 PM Delivery"
    };
  }
  if (s === "8am" || s === "breakfast") {
    return {
      title: "BREAKFAST PREP BATCH",
      deliveryTime: "8:00 AM Delivery",
      timeSlot: "7:30 AM Prep • 8:00 AM Delivery"
    };
  }
  return {
    title: `${(slot || "DAILY").toUpperCase()} PREP BATCH`,
    deliveryTime: slot || "Scheduled Slot",
    timeSlot: slot || "Scheduled Slot"
  };
}

export default function VendorDashboard() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { batches, pickups, deliveries, subscriptions, loading, managedVendor, allVendors, activeVendorId, setActiveVendorId } = useVendorData();
  const vendorProfile = managedVendor || user;

  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [isLocationModalOpen, setIsLocationModalOpen] = useState(false);

  const isSuper = (user?.email || '').toLowerCase().trim() === 'closeon.st@gmail.com' || 
                  user?.is_superadmin === true || 
                  user?.roles?.admin === true || 
                  user?.role === 'admin';
  const isVendorRole = user?.role === 'vendor' || isSuper;
  const isVerifiedVendor = (user?.is_approved === true || user?.verification_status === 'verified' || isSuper) &&
    user?.is_rejected !== true && user?.is_suspended !== true &&
    user?.verification_status !== 'rejected' && user?.verification_status !== 'details_requested';

  // Custom confirmation dialog state
  const [confirmConfig, setConfirmConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    variant?: 'danger' | 'primary' | 'warning';
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const [isMarkingReady, setIsMarkingReady] = useState<string | null>(null);
  const [selectedDateDetails, setSelectedDateDetails] = useState<{ dateKey: string; displayDate: string; details: any[] } | null>(null);

  // Live rider location tracking
  const [riderLocations, setRiderLocations] = useState<Record<string, { lat: number; lng: number } | null>>({});

  useEffect(() => {
    if (!pickups.length) return;
    const unsubs: (() => void)[] = [];
    pickups.forEach((trip: any) => {
      if (!trip.riderId) return;
      const unsub = onSnapshot(doc(db, 'driver_profiles', trip.riderId), (snap) => {
        if (snap.exists()) {
          const loc = snap.data().currentLocation;
          if (loc?.lat && loc?.lng) {
            setRiderLocations((prev) => ({ ...prev, [trip.riderId]: { lat: loc.lat, lng: loc.lng } }));
          }
        }
      });
      unsubs.push(unsub);
    });
    return () => unsubs.forEach((u) => u());
  }, [pickups]);

  // Derive schedule forecast from subscriptions (next 30 days)
  const prepSchedule = useMemo(() => {
    const grouped: any = {};
    const now = new Date();
    
    for (let i = 0; i <= 30; i++) {
      const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const dateKey = targetDate.toLocaleDateString('en-CA');
      const displayDate = targetDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const dayOfWeek = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      const shortDay = targetDate.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();

      subscriptions.forEach((sub: any) => {
        // Only active subscriptions
        if (sub.status && sub.status !== 'active') return;

        // Parse date boundaries
        const parseDate = (val: any): Date | null => {
          if (!val) return null;
          if (val.toDate && typeof val.toDate === 'function') return val.toDate();
          if (val._seconds) return new Date(val._seconds * 1000);
          if (val instanceof Date) return val;
          const parsed = new Date(val);
          return isNaN(parsed.getTime()) ? null : parsed;
        };

        const startDate = parseDate(sub.start_date || sub.startDate || sub.start_at);
        const endDate = parseDate(sub.end_date || sub.endDate || sub.end_at || sub.next_billing_date || sub.nextBillingDate);

        const checkDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());

        if (startDate) {
          const sNorm = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
          if (checkDate < sNorm) return;
        }

        if (endDate) {
          const eNorm = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
          // Inclusive of the end/renewal day
          if (checkDate > eNorm) return;
        }

        // If custom monthly plan with exact selected dates
        if (Array.isArray(sub.selected_dates) && sub.selected_dates.length > 0) {
          if (!sub.selected_dates.includes(dateKey)) return;
        }

        let shouldDeliverToday = true;
        let mealsToday = 1;
        if (sub.deliveryPattern) {
          const count = sub.deliveryPattern[dayOfWeek] ?? sub.deliveryPattern[shortDay];
          if (count !== undefined) {
            shouldDeliverToday = Number(count) > 0;
            mealsToday = Number(count);
          }
        }

        if (!shouldDeliverToday) return;

        const addProjected = (mealType: string, slot: string) => {
          const key = `${dateKey}_${mealType}_${slot}`;
          if (!grouped[key]) {
            grouped[key] = { 
              dateKey, displayDate, dateObj: targetDate, sortDate: targetDate.getTime(), 
              mealType, slot, count: 0, isProjected: true 
            };
          }
          grouped[key].count++;
        };

        if (sub.deliveryPattern) {
          if (mealsToday >= 2) {
            addProjected("lunch", sub.deliveryPreference || "11am");
            addProjected("dinner", "8pm");
          } else {
            const effSlot = sub.delivery_slot || sub.deliverySlot;
            const singleMeal = effSlot === "dinner" ? "dinner" : "lunch";
            addProjected(singleMeal, singleMeal === "dinner" ? "8pm" : (sub.deliveryPreference || "11am"));
          }
        } else {
          const effSlot = sub.delivery_slot || sub.deliverySlot || null;
          if (effSlot === "dinner") {
            addProjected("dinner", "8pm");
          } else if (effSlot === "lunch") {
            addProjected("lunch", sub.deliveryPreference || "11am");
          } else if (effSlot === "both" || (!effSlot && sub.meal_type === "both")) {
            addProjected("lunch", sub.deliveryPreference || "11am");
            addProjected("dinner", "8pm");
          } else if (!effSlot && sub.meal_type === "dinner") {
            addProjected("dinner", "8pm");
          } else {
            addProjected("lunch", sub.deliveryPreference || "11am");
          }
        }
      });
    }

    return Object.values(grouped).sort((a: any, b: any) => a.sortDate - b.sortDate);
  }, [subscriptions]);

  const handleMarkReady = async (batch: any) => {
    const bInfo = formatBatchTitle(batch.slot);
    setConfirmConfig({
      isOpen: true,
      title: 'Confirm Batch Ready?',
      message: `Are you sure you want to mark all ${batch.total_count} tiffins as ready for the ${bInfo.title} (${bInfo.deliveryTime})? This immediately notifies assigned dispatch riders.`,

      confirmLabel: 'Mark Ready',
      variant: 'primary',
      onConfirm: async () => {
        setConfirmConfig(prev => ({ ...prev, isOpen: false }));
        setIsMarkingReady(batch.id);
        try {
          const markBatchReady = httpsCallable(functions, 'markBatchReady');
          const res = await markBatchReady({ batch_id: batch.id }) as any;
          if (res.data?.success) {
            toast.success('Batch marked ready! Assigning riders…');
          } else {
            toast.error(res.data?.message || 'Failed to mark ready.');
          }
        } catch (e: unknown) {
          console.error(e);
          toast.error(getErrorMessage(e) || 'Error marking batch ready.');
        } finally {
          setIsMarkingReady(null);
        }
      }
    });
  };

  const localToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const todayBatches = batches.filter(b => b.date === localToday);
  const totalTodayTiffins = todayBatches.reduce((acc, b) => acc + (b.total_orders || b.tiffin_count || b.total_count || 1), 0);
  const kitchenCapacity = vendorProfile?.capacity || user?.capacity || 20;
  const subscriberCount = subscriptions.length;
  const capacityPercent = Math.min(100, Math.round((subscriberCount / kitchenCapacity) * 100));
  const totalRevenue = subscriptions.reduce((sum, s: any) => sum + (s.total_price || s.base_price || s.price || 0), 0);

  const [packedBoxes, setPackedBoxes] = useState<Record<string, boolean>>({});
  const [tagFilterSlot, setTagFilterSlot] = useState<'lunch' | 'dinner'>(() => {
    const hour = new Date().getHours();
    return hour < 15 ? 'lunch' : 'dinner';
  });
  const [showAllPackedModal, setShowAllPackedModal] = useState(false);

  // Auto-align tagFilterSlot to slot with actual subscriptions/batches
  useEffect(() => {
    if (subscriptions.length > 0) {
      const hasLunch = subscriptions.some((s: any) => {
        const eff = s.delivery_slot || s.deliverySlot || s.meal_type;
        return eff === 'lunch' || eff === 'both';
      });
      const hasDinner = subscriptions.some((s: any) => {
        const eff = s.delivery_slot || s.deliverySlot || s.meal_type;
        return eff === 'dinner' || eff === 'both';
      });
      if (!hasLunch && hasDinner) {
        setTagFilterSlot('dinner');
      } else if (hasLunch && !hasDinner) {
        setTagFilterSlot('lunch');
      }
    }
  }, [subscriptions]);

  // Real-order "Today's Preparation" — recomputed from the orders collection
  // every 60s so it reflects live status changes (marks-ready, dispatches,
  // cancellations, skips) without relying on batch totals.
  const [prepSummary, setPrepSummary] = useState<{
    total: number; needsPrep: number; lunch: number; dinner: number;
    dispatched: number; delivered: number; cancelled: number;
    byStatus: Record<string, number>;
} | null>(null);

  // Today's Orders drill-down (real order docs behind the prep counts).
  const [prepOrders, setPrepOrders] = useState<any[] | null>(null);
  const [prepModalOpen, setPrepModalOpen] = useState(false);
  const [loadingPrepOrders, setLoadingPrepOrders] = useState(false);

  const openPrepDrillDown = async () => {
    const vendorId = vendorProfile?.id || user?.id;
    if (!vendorId) return;
    setLoadingPrepOrders(true);
    setPrepModalOpen(true);
    try {
      const details = await getVendorPrepDetails(
        vendorId,
        new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
      );
      setPrepOrders(details.rows);
    } catch (err) {
      console.warn('Prep drill-down failed:', err);
      toast.error("Couldn't load today's orders");
      setPrepOrders([]);
    } finally {
      setLoadingPrepOrders(false);
    }
  };

  useEffect(() => {
    const vendorId = vendorProfile?.id || user?.id;
    if (!vendorId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const summary = await getVendorPrepSummary(
          vendorId,
          new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
        );
        if (!cancelled) setPrepSummary(summary);
      } catch (err) {
        if (!cancelled) console.warn('Prep summary unavailable:', err);
      }
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [vendorProfile?.id, user?.id]);

  const TABS: { key: ActiveTab; label: string; icon: any }[] = [
    { key: 'overview', label: 'Operations & Dispatch', icon: Activity },
    { key: 'tags', label: '🏷️ Box Tags & Pack', icon: Tag },
    { key: 'menu', label: "Today's Menu", icon: UtensilsCrossed },
    { key: 'subscribers', label: `Subscribers (${subscriptions.length})`, icon: Users },
    { key: 'rates', label: 'Rates & Pricing', icon: IndianRupee },
  ];

  if (user && (!isVendorRole || !isVerifiedVendor)) {
    return <PendingVerificationScreen role="vendor" />;
  }

  if (loading) {
    return (
      <div className="flex h-[75vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-brand/10 text-brand flex items-center justify-center animate-bounce">
            <ChefHat className="w-6 h-6" />
          </div>
          <p className="text-xs font-black uppercase tracking-widest text-slate-400">Loading Kitchen Hub…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in pb-16 max-w-7xl mx-auto px-2 sm:px-4">

      {/* ── TOP HERO KITCHEN CARD ────────────────────────────────────────── */}
      <div className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200/80 shadow-[0_4px_24px_rgba(15,23,42,0.04)]">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-amber-500 to-brand flex items-center justify-center text-white font-black text-2xl shadow-lg shadow-brand/20 shrink-0">
              {vendorProfile?.kitchen_name?.[0]?.toUpperCase() || vendorProfile?.name?.[0]?.toUpperCase() || 'K'}
            </div>

            {/* min-w-0 is required here. A flex child defaults to
                min-width:auto, so it refuses to shrink below its content and
                pushes the whole page wider than the viewport -- which is what
                made the vendor dashboard scroll sideways on a phone. */}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                  {vendorProfile?.kitchen_name || vendorProfile?.name || 'Kitchen Hub'}
                </h1>
                <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border border-emerald-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Verified Kitchen
                </span>
                <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full text-[10px] font-black border border-amber-200">
                  <Star className="w-3 h-3 fill-amber-400 text-amber-500" /> {Number(vendorProfile?.rating_avg || vendorProfile?.rating || 4.5).toFixed(1)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500 font-medium">
                <span className="flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span>{vendorProfile?.address || vendorProfile?.location?.address || 'Nagpur, Maharashtra'}</span>
                  {isSuper && (
                    <button
                      type="button"
                      onClick={() => setIsLocationModalOpen(true)}
                      title="Superadmin: Update this vendor's address and GPS location"
                      className="ml-1 text-[11px] font-black text-amber-700 hover:text-amber-800 bg-amber-50 hover:bg-amber-100/80 px-2 py-0.5 rounded-lg border border-amber-200 transition-all inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Pencil className="w-2.5 h-2.5" />
                      <span>Edit Location</span>
                    </button>
                  )}
                </span>
                <span className="flex items-center gap-1">
                  <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  {vendorProfile?.phone || vendorProfile?.phone_number || '+919900990022'}
                </span>
                <span className="text-slate-400">•</span>
                <span className="text-brand font-bold">{vendorProfile?.cuisine_type || 'Home Style'}</span>
              </div>

              {/* Superadmin Kitchen Switcher Toggle Under Location */}
              {isSuper && allVendors.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mt-2.5 pt-2 border-t border-slate-100">
                  <div className="inline-flex min-w-0 max-w-full items-center gap-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200/90 px-2.5 py-1 rounded-xl transition-all shadow-2xs">
                    <ChefHat className="w-3.5 h-3.5 text-brand shrink-0" />
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 shrink-0">Switch Kitchen:</span>
                    <select
                      id="kitchen-switch"
                      value={activeVendorId || vendorProfile?.id || ''}
                      onChange={(e) => setActiveVendorId(e.target.value)}
                      className="min-w-0 max-w-[45vw] sm:max-w-none truncate bg-transparent text-xs font-black text-slate-900 outline-none cursor-pointer pr-1"
                    >
                      {allVendors.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.kitchen_name || v.name || 'Kitchen'} — {v.address?.split(',')?.[0] || v.city || 'Nagpur'} {v.id === 'kb4yMdXRFBR2AhZWnY2GloUbHxR2' ? '★' : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={() => setIsLocationModalOpen(true)}
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-2.5 py-1 rounded-xl transition-all shadow-2xs active:scale-[0.98] cursor-pointer"
                    title="Superadmin: Update this vendor's address and GPS location"
                  >
                    <MapPin className="w-3 h-3 text-amber-600" />
                    <span>Update Location</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Status & Actions */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="bg-emerald-50 text-emerald-700 px-4 py-2 rounded-2xl border border-emerald-200 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)] animate-pulse" />
              <div className="text-left">
                <div className="text-[10px] font-black uppercase tracking-wider text-emerald-600">Kitchen Status</div>
                <div className="text-xs font-bold text-emerald-900 leading-tight">Online & Receiving Orders</div>
              </div>
            </div>

            <button 
              onClick={logout} 
              className="px-4 py-2.5 rounded-2xl text-xs font-bold text-slate-600 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 border border-slate-200 transition-all active:scale-[0.98]"
            >
              Sign Out
            </button>
          </div>
        </div>

        {/* Navigation Tabs Bar */}
        <div className="flex items-center gap-2 mt-6 pt-5 border-t border-slate-100 overflow-x-auto scrollbar-none">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-bold transition-all shrink-0 active:scale-[0.98] ${
                  active
                    ? 'bg-slate-900 text-white shadow-md shadow-slate-900/10'
                    : 'bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${active ? 'text-brand' : 'text-slate-400'}`} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── TAB 1: OPERATIONS & DISPATCH OVERVIEW ────────────────────────── */}
      {activeTab === 'overview' && (
        <div className="space-y-6 animate-fade-in">
          {/* Key Metrics Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            
            {/* 1. Active Subscribers */}
            <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200/80 shadow-[0_4px_20px_rgba(15,23,42,0.03)] flex flex-col justify-between">
              <div className="flex items-start justify-between gap-2 text-slate-400 text-[10px] sm:text-xs font-bold mb-2">
                <span className="uppercase tracking-wide sm:tracking-wider leading-tight">Active Subscribers</span>
                <div className="w-8 h-8 rounded-xl bg-amber-50 text-brand flex items-center justify-center shrink-0">
                  <Users className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-3xl font-black text-slate-900">{subscriberCount}</div>
                <div className="text-[11px] font-semibold text-emerald-600 mt-1 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Active recurring eaters
                </div>
              </div>
            </div>

            {/* 2. Today's Prep Volume — REAL count from order documents */}
            <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200/80 shadow-[0_4px_20px_rgba(15,23,42,0.03)] flex flex-col justify-between">
              <div className="flex items-start justify-between gap-2 text-slate-400 text-[10px] sm:text-xs font-bold mb-2">
                <span className="uppercase tracking-wide sm:tracking-wider leading-tight">Today's Preparation</span>
                <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                  <ChefHat className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-3xl font-black text-slate-900">
                  {prepSummary != null && prepSummary.total > 0
                    ? prepSummary.needsPrep
                    : (totalTodayTiffins > 0
                      ? totalTodayTiffins
                      : subscriptions.reduce((acc: number, sub: any) => {
                          const effSlot = sub.delivery_slot || sub.deliverySlot || null;
                          const hasBoth = !effSlot && sub.meal_type === 'both';
                          return acc + (hasBoth ? 2 : 1);
                        }, 0))
                  }{' '}
                  <span className="text-base font-bold text-slate-400">Tiffins</span>
                </div>
                <div className="text-[11px] font-semibold text-slate-500 mt-1">
                  {prepSummary != null && prepSummary.total > 0
                    ? `Lunch ${prepSummary.lunch} · Dinner ${prepSummary.dinner} · ${prepSummary.dispatched} dispatched · ${prepSummary.delivered} delivered`
                    : (() => {
                        const hasLunch = subscriptions.some((s: any) => {
                          const effSlot = s.delivery_slot || s.deliverySlot || null;
                          return effSlot === 'lunch' || (!effSlot && (s.meal_type === 'lunch' || s.meal_type === 'both' || !s.meal_type));
                        });
                        const hasDinner = subscriptions.some((s: any) => {
                          const effSlot = s.delivery_slot || s.deliverySlot || null;
                          return effSlot === 'dinner' || (!effSlot && (s.meal_type === 'dinner' || s.meal_type === 'both'));
                        });
                        return hasLunch && hasDinner ? 'Lunch & Dinner batches' : hasLunch ? 'Lunch batch only' : 'Dinner batch only';
                      })()}
                </div>
                {prepSummary != null && prepSummary.total > 0 && (
                  <div className="text-[10px] font-bold text-slate-400 mt-1.5">
                    Includes {prepSummary.cancelled} cancelled/skipped today
                  </div>
                )}
              </div>
            </div>

            {/* 3. Kitchen Capacity */}
            <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200/80 shadow-[0_4px_20px_rgba(15,23,42,0.03)] flex flex-col justify-between">
              <div className="flex items-start justify-between gap-2 text-slate-400 text-[10px] sm:text-xs font-bold mb-2">
                <span className="uppercase tracking-wide sm:tracking-wider leading-tight">Slot Capacity</span>
                <div className="w-8 h-8 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center shrink-0">
                  <Activity className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-black text-slate-900">{subscriberCount}</span>
                  <span className="text-sm font-bold text-slate-400">/ {kitchenCapacity} Slots</span>
                </div>
                <div className="w-full bg-slate-100 h-2 rounded-full mt-2 overflow-hidden">
                  <div className="bg-gradient-to-r from-brand to-amber-500 h-full rounded-full transition-all duration-500" style={{ width: `${capacityPercent}%` }} />
                </div>
              </div>
            </div>

            {/* 4. Total Revenue */}
            <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200/80 shadow-[0_4px_20px_rgba(15,23,42,0.03)] flex flex-col justify-between">
              <div className="flex items-start justify-between gap-2 text-slate-400 text-[10px] sm:text-xs font-bold mb-2">
                <span className="uppercase tracking-wide sm:tracking-wider leading-tight">Estimated Revenue</span>
                <div className="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                  <IndianRupee className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-3xl font-black text-slate-900">₹{(subscriberCount * 3600).toLocaleString('en-IN')}</div>
                <div className="text-[11px] font-semibold text-emerald-600 mt-1">Processed monthly total</div>
              </div>
            </div>

          </div>

          {/* Real-order Preparation Breakdown by status */}
          {prepSummary != null && prepSummary.total > 0 && (
            <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200/80 shadow-[0_4px_20px_rgba(15,23,42,0.03)]">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                  <ChefHat className="w-4 h-4 text-brand" />
                  Today's Preparation — Live Order Breakdown
                </h3>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    From {prepSummary.total} real orders
                  </span>
                  <button
                    type="button"
                    onClick={openPrepDrillDown}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 text-white text-[10px] font-black uppercase tracking-wider shadow-sm hover:bg-slate-800 active:scale-95 transition-all cursor-pointer"
                  >
                    <PackageCheck className="w-3.5 h-3.5" />
                    View Orders
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(prepSummary.byStatus).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => (
                  <div
                    key={status}
                    className="flex items-center gap-1.5 rounded-xl bg-slate-50 border border-slate-200/80 px-3 py-1.5"
                  >
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">{status.replace(/_/g, ' ')}</span>
                    <span className="text-sm font-black text-slate-900">{count}</span>
                  </div>
                ))}
              </div>
              {prepSummary.cancelled > 0 && (
                <div className="mt-3 flex items-center gap-2 rounded-xl bg-red-50 border border-red-100 px-3 py-2">
                  <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                  <p className="text-[11px] font-bold text-red-700">
                    {prepSummary.cancelled} cancelled/skipped tiffin{prepSummary.cancelled > 1 ? 's' : ''} today — {prepSummary.needsPrep} still need preparation.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Main 2-Column Dispatch Center */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* LEFT: Today's Prep Batches & Handover */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-black text-slate-900 flex items-center gap-2">
                  <PackageCheck className="w-5 h-5 text-brand" />
                  Today's Batches & Rider Dispatch
                </h3>
                <span className="text-xs font-bold text-slate-400">
                  {new Date().toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' })}
                </span>
              </div>

              {todayBatches.length === 0 ? (
                <div className="bg-white rounded-3xl border border-slate-200/80 p-8 text-center shadow-xs">
                  <div className="w-14 h-14 rounded-2xl bg-amber-50 text-brand flex items-center justify-center mx-auto mb-3">
                    <ChefHat className="w-7 h-7" />
                  </div>
                  <h4 className="text-base font-black text-slate-900">Ready for Daily Preparation</h4>
                  <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                    Active subscriber orders are queued. Batches will automatically appear here for 1-click readiness marking.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {todayBatches.map((batch) => {
                    const matchingTrip = pickups.find(p =>
                      p.batch_ids?.includes(batch.id) ||
                      p.id === batch.trip_id ||
                      p.assignedOrderIds?.some((oid: string) => batch.order_ids?.includes(oid))
                    );
                    const myStop = matchingTrip?.pickupStops?.find((s: any) => s.vendorId === (vendorProfile?.id || user?.id));

                    const isHandoverDone = 
                      batch.status === 'picked_up' || 
                      batch.status === 'completed' || 
                      myStop?.status === 'completed' || 
                      ['pickup_complete', 'dropping', 'completed'].includes(matchingTrip?.status);

                    const isDeliveryDone = 
                      batch.status === 'completed' || 
                      matchingTrip?.status === 'completed' || 
                      (matchingTrip?.dropStops && matchingTrip.dropStops.length > 0 && matchingTrip.dropStops.every((d: any) => d.status === 'completed')) ||
                      (batch.order_ids && batch.order_ids.length > 0 && batch.order_ids.every((oid: string) => deliveries.find(d => d.id === oid)?.status === 'delivered'));

                    const riderName = matchingTrip?.riderName || batch.rider_name || 'Salary Fleet Rider';
                    const riderPhone = matchingTrip?.riderPhone;

                    const effectiveStatusKey: BatchStatus = isDeliveryDone
                      ? 'completed'
                      : isHandoverDone
                      ? 'picked_up'
                      : (batch.status as BatchStatus);
                    const disp = BATCH_STATUS_DISPLAY[effectiveStatusKey] ?? BATCH_STATUS_DISPLAY.pending;
                    const canMarkReady = !['ready', 'pickup_in_progress', 'picked_up', 'completed'].includes(batch.status) && !isHandoverDone && !isDeliveryDone;

                    return (
                      <div key={batch.id} className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-xs space-y-4">
                        <div className="flex items-start justify-between">
                          <div>
                            {(() => {
                              const bInfo = formatBatchTitle(batch.slot);
                              return (
                                <>
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[10px] font-black uppercase tracking-wider text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200/80">
                                      {bInfo.title}
                                    </span>
                                    <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                                      {bInfo.deliveryTime}
                                    </span>
                                  </div>
                                  <div className="flex items-baseline gap-2 mt-1.5">
                                    <span className="text-3xl font-black text-slate-900">{batch.total_count}</span>
                                    <span className="text-sm font-bold text-slate-500">Tiffins</span>
                                  </div>
                                </>
                              );
                            })()}
                          </div>

                          <span className={`text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-full border ${disp.bg} ${disp.color} ${disp.border}`}>
                            {disp.label}
                          </span>
                        </div>

                        {canMarkReady && (
                          <button
                            onClick={() => handleMarkReady(batch)}
                            disabled={isMarkingReady === batch.id}
                            className="w-full py-3.5 rounded-2xl font-black text-xs uppercase tracking-wider bg-brand hover:bg-amber-600 text-white shadow-md shadow-brand/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50"
                          >
                            <PackageCheck className="w-4 h-4" />
                            {isMarkingReady === batch.id ? 'Confirming Dispatch…' : `Mark ${batch.total_count} Tiffins Ready For Rider`}
                          </button>
                        )}

                        {isDeliveryDone ? (
                          <div className="p-4 bg-emerald-50 rounded-2xl border-2 border-emerald-200 text-center space-y-2 animate-scale-up">
                            <div className="flex items-center justify-center gap-2 text-emerald-800 font-black text-sm">
                              <div className="w-7 h-7 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-xs">
                                <CheckCircle className="w-4 h-4" />
                              </div>
                              <span>🎉 Delivery Completed!</span>
                            </div>
                            <p className="text-xs text-emerald-700 font-medium max-w-xs mx-auto">
                              All tiffins delivered fresh to customer by <strong>{riderName}</strong>. Handover & dispatch cycle finished.
                            </p>
                            <div className="flex items-center justify-center gap-2 pt-1 flex-wrap">
                              <span className="text-[10px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full border border-emerald-200">
                                Handover Verified ✓
                              </span>
                              <span className="text-[10px] font-black uppercase tracking-wider bg-emerald-600 text-white px-3 py-1 rounded-full shadow-xs">
                                Delivered to Customer ✓
                              </span>
                            </div>
                          </div>
                        ) : isHandoverDone ? (
                          <div className="p-4 bg-blue-50/90 rounded-2xl border-2 border-blue-200 text-center space-y-2 animate-scale-up">
                            <div className="flex items-center justify-center gap-2 text-blue-900 font-black text-sm">
                              <div className="w-7 h-7 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-xs">
                                <Truck className="w-4 h-4" />
                              </div>
                              <span>🛵 Tiffin Handover Done — Out for Delivery</span>
                            </div>
                            <p className="text-xs text-blue-700 font-medium max-w-xs mx-auto">
                              Handover OTP verified with <strong>{riderName}</strong>. Meals are currently on their way to customer doorstep.
                            </p>
                            <div className="flex items-center justify-center gap-2 pt-1 flex-wrap">
                              <span className="text-[10px] font-black uppercase tracking-wider bg-blue-100 text-blue-800 px-3 py-1 rounded-full border border-blue-200">
                                Handover Done ✓
                              </span>
                              <span className="text-[10px] font-black uppercase tracking-wider bg-blue-600 text-white px-3 py-1 rounded-full shadow-xs animate-pulse">
                                Rider Delivering…
                              </span>
                            </div>
                            {riderPhone && (
                              <div className="pt-1">
                                <a
                                  href={`tel:${riderPhone}`}
                                  className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-700 bg-white px-3 py-1.5 rounded-xl border border-blue-200 shadow-xs hover:bg-blue-50 cursor-pointer"
                                >
                                  <Phone className="w-3.5 h-3.5" /> Call Rider ({riderName})
                                </a>
                              </div>
                            )}
                          </div>
                        ) : batch.status === 'ready' ? (
                          <div className="p-4 bg-emerald-50/80 rounded-2xl border border-emerald-200 text-center space-y-2">
                            <div className="flex items-center justify-center gap-1.5 text-emerald-700 font-bold text-xs">
                              <CheckCircle className="w-4 h-4 text-emerald-600" />
                              Tiffins Ready! Awaiting Rider Pickup
                            </div>

                            {(() => {
                              const tripOTP = myStop?.pickupOTP;
                              const displayOTP = batch.pickup_otp || tripOTP || '----';

                              return (
                                <div className="mt-2 bg-white py-3 px-6 rounded-2xl border border-emerald-200 inline-block shadow-sm">
                                  <div className="text-[10px] font-black uppercase tracking-widest text-emerald-700 mb-0.5">Rider Handover OTP</div>
                                  <div className="text-3xl font-black font-mono tracking-[0.25em] text-emerald-600">{displayOTP}</div>
                                </div>
                              );
                            })()}
                            <p className="text-[11px] text-slate-500 font-medium">Read this 4-digit code to the rider when they arrive at the counter.</p>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Assigned Riders Dispatch & Live Delivery Status */}
              {pickups.length > 0 && (
                <div className="space-y-3 pt-2">
                  <h4 className="text-sm font-black text-slate-900 flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                    Assigned Riders & Delivery Tracking
                  </h4>

                  {pickups.map((trip) => {
                    const myStop = trip.pickupStops?.find((s: any) => s.vendorId === (vendorProfile?.id || user?.id));
                    const isTripDelivered = trip.status === 'completed' || (trip.dropStops && trip.dropStops.length > 0 && trip.dropStops.every((s: any) => s.status === 'completed'));
                    const isPickedUp = myStop?.status === 'completed' || ['pickup_complete', 'dropping', 'completed'].includes(trip.status);

                    return (
                      <div
                        key={trip.id}
                        className={`rounded-3xl p-5 border space-y-3 ${
                          isTripDelivered
                            ? 'bg-emerald-50/80 border-emerald-200'
                            : isPickedUp
                            ? 'bg-blue-50/80 border-blue-200'
                            : 'bg-amber-50/80 border-amber-200'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full ${
                              isTripDelivered
                                ? 'bg-emerald-200/80 text-emerald-900'
                                : isPickedUp
                                ? 'bg-blue-200/80 text-blue-900'
                                : 'bg-amber-200/60 text-amber-800'
                            }`}
                          >
                            {isTripDelivered
                              ? 'Delivered to Customer'
                              : isPickedUp
                              ? 'Out for Delivery'
                              : 'Rider En Route to Kitchen'}
                          </span>
                          {trip.riderPhone && (
                            <a
                              href={`tel:${trip.riderPhone}`}
                              className="text-xs font-bold text-slate-800 bg-white px-3 py-1.5 rounded-xl border border-slate-200 flex items-center gap-1.5 shadow-xs hover:bg-slate-50"
                            >
                              <Phone className="w-3.5 h-3.5 text-brand" /> Call {trip.riderName || 'Rider'}
                            </a>
                          )}
                        </div>

                        <div>
                          <h5 className="font-bold text-slate-900 text-base">
                            {isTripDelivered
                              ? `${trip.riderName || 'Rider'} completed delivery!`
                              : isPickedUp
                              ? `${trip.riderName || 'Rider'} is delivering tiffins to customer`
                              : `${trip.riderName || 'Rider'} is arriving at your kitchen`}
                          </h5>
                          <p className="text-xs text-slate-600 mt-0.5">
                            {isTripDelivered
                              ? 'Customer has received their fresh tiffins. Order fulfilled.'
                              : isPickedUp
                              ? 'Handover completed. Rider is en route to customer doorstep.'
                              : 'Hand over the prepared lunch/dinner packs when rider arrives.'}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* RIGHT: 30-Day Demand Heatmap */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-black text-slate-900 flex items-center gap-2">
                  <CalendarClock className="w-5 h-5 text-indigo-600" />
                  30-Day Tiffin Forecast Calendar
                </h3>
                <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100">
                  {subscriberCount} Active Subscribers
                </span>
              </div>

              <div className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-xs">
                <div className="grid grid-cols-7 gap-1 sm:gap-2 mb-3">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                    <div key={day} className="text-center text-[10px] font-black text-slate-400 uppercase tracking-wider">
                      {day}
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-7 gap-1 sm:gap-2">
                  {(() => {
                    const groupedByDate: Record<string, { displayDate: string; totalCount: number; details: any[] }> = {};
                    prepSchedule.forEach((prep: any) => {
                      if (!groupedByDate[prep.dateKey]) {
                        groupedByDate[prep.dateKey] = { displayDate: prep.displayDate, totalCount: 0, details: [] };
                      }
                      groupedByDate[prep.dateKey].totalCount += prep.count;
                      groupedByDate[prep.dateKey].details.push(prep);
                    });

                    const today = new Date();
                    const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
                    
                    const calendarCells = [];
                    for (let i = 0; i < 28; i++) {
                      const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
                      const dKey = d.toLocaleDateString('en-CA');
                      const dayData = groupedByDate[dKey];
                      const isToday = dKey === localToday;
                      const isPast = d < new Date(today.getFullYear(), today.getMonth(), today.getDate());
                      const tiffinCount = dayData ? dayData.totalCount : 0;
                      
                      calendarCells.push(
                        <div 
                          key={dKey} 
                          onClick={() => {
                            if (!isPast) setSelectedDateDetails({ 
                              dateKey: dKey, 
                              displayDate: d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' }), 
                              details: dayData?.details || [] 
                            });
                          }}
                          className={`
                            aspect-square rounded-2xl border flex flex-col items-center justify-center p-1 transition-all
                            ${isToday ? 'bg-amber-500 text-white font-bold border-amber-500 shadow-md shadow-amber-500/20 scale-105 z-10' : ''}
                            ${!isToday && !isPast ? 'bg-slate-50 hover:bg-amber-50 border-slate-200/80 hover:border-amber-200 cursor-pointer' : ''}
                            ${isPast ? 'opacity-40 grayscale bg-slate-50/50 border-slate-100 cursor-not-allowed' : ''}
                          `}
                        >
                          <span className={`text-xs font-black ${isToday ? 'text-white' : 'text-slate-800'}`}>
                            {d.getDate()}
                          </span>
                          {!isPast && tiffinCount > 0 && (
                            <span className={`mt-0.5 text-[9px] font-black px-1.5 py-0.2 rounded-full ${isToday ? 'bg-white text-slate-900' : 'bg-brand/10 text-brand'}`}>
                              {tiffinCount}
                            </span>
                          )}
                        </div>
                      );
                    }
                    return calendarCells;
                  })()}
                </div>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ── TAB: BOX TAGS & PACKING BOARD ──────────────────────────────── */}
      {activeTab === 'tags' && (() => {
        // Generate discrete box items based on active slot filter
        const boxItems: Array<{
          sub: any;
          key: string;
          slotLabel: string;
          slotType: 'lunch' | 'dinner';
          isVeg: boolean;
        }> = [];

        subscriptions.forEach((sub: any) => {
          const isNonVeg = sub.dietary === 'non_veg' || sub.category === 'non_veg' || (sub.meal_type as any) === 'non_veg';
          const isVeg = !isNonVeg;
          // delivery_slot is authoritative — meal_type='both' only applies when no delivery_slot or effSlot='both'
          const effectiveSlot = sub.delivery_slot || sub.deliverySlot || null;
          const servesLunch = effectiveSlot === 'lunch' || effectiveSlot === 'both' || (!effectiveSlot && (sub.meal_type === 'lunch' || sub.meal_type === 'both' || !sub.meal_type));
          const servesDinner = effectiveSlot === 'dinner' || effectiveSlot === 'both' || (!effectiveSlot && (sub.meal_type === 'dinner' || sub.meal_type === 'both'));

          if (servesLunch && tagFilterSlot === 'lunch') {
            boxItems.push({
              sub,
              key: `${sub.id}_lunch`,
              slotLabel: sub.deliveryPreference || 'Lunch (1:00 PM)',
              slotType: 'lunch',
              isVeg
            });
          }
          if (servesDinner && tagFilterSlot === 'dinner') {
            boxItems.push({
              sub,
              key: `${sub.id}_dinner`,
              slotLabel: 'Dinner (8:00 PM)',
              slotType: 'dinner',
              isVeg
            });
          }
        });

        const totalVeg = boxItems.filter(b => b.isVeg).length;
        const totalNonVeg = boxItems.filter(b => !b.isVeg).length;
        const totalPacked = boxItems.filter(b => packedBoxes[b.key]).length;

        // Match today's batch for the active slot
        const activeSlotBatch = todayBatches.find((b: any) => {
          const bSlot = (b.slot || '').toLowerCase();
          return tagFilterSlot === 'lunch'
            ? (bSlot === 'lunch' || bSlot === '11am' || bSlot === '1pm')
            : (bSlot === 'dinner' || bSlot === '8pm' || bSlot === '7pm');
        });

        // Match active pickup trip strictly for the active slot
        const activePickupTrip = pickups.find((p: any) => {
          const tripSlot = (p.slot || '').toLowerCase();
          const isMatchingSlot = tagFilterSlot === 'lunch'
            ? (tripSlot === 'lunch' || tripSlot === '11am' || tripSlot === '1pm')
            : (tripSlot === 'dinner' || tripSlot === '8pm' || tripSlot === '7pm');

          if (!isMatchingSlot) return false;

          if (activeSlotBatch && (p.batch_ids?.includes(activeSlotBatch.id) || p.assignedOrderIds?.some((oid: string) => activeSlotBatch.order_ids?.includes(oid)))) {
            return true;
          }
          return p.pickupStops?.some((s: any) => s.vendorId === (vendorProfile?.id || user?.id));
        });

        const myStop = activePickupTrip?.pickupStops?.find((s: any) => s.vendorId === (vendorProfile?.id || user?.id));
        const handoverOTP = activeSlotBatch?.pickup_otp || myStop?.pickupOTP;
        const isBatchReady = activeSlotBatch?.status === 'ready' || activeSlotBatch?.status === 'notified';
        const isHandoverDone = 
          activeSlotBatch?.status === 'picked_up' || 
          activeSlotBatch?.status === 'completed' || 
          myStop?.status === 'completed' || 
          (activePickupTrip && ['pickup_complete', 'dropping', 'completed'].includes(activePickupTrip.status));
        const isTagDelivered = 
          activeSlotBatch?.status === 'completed' || 
          activePickupTrip?.status === 'completed' || 
          (activePickupTrip?.dropStops && activePickupTrip.dropStops.length > 0 && activePickupTrip.dropStops.every((d: any) => d.status === 'completed'));

        // Never show dispatch/delivery banner if this slot has 0 boxes to prepare or deliver
        const hasTiffinsForSlot = boxItems.length > 0 || (activeSlotBatch && (activeSlotBatch.total_count || 0) > 0);

        return (
          <div className="space-y-6 animate-fade-in">
            {/* Header & Instructions */}
            <div className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200/80 shadow-xs space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-wider text-brand bg-brand/10 px-3 py-1 rounded-full border border-brand/20">
                      Zero-Mismatch System
                    </span>
                    <span className="text-xs font-bold text-slate-600 bg-slate-100 px-3 py-1 rounded-full border border-slate-200 flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-brand" />
                      Today • {new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date())}
                    </span>
                  </div>
                  <h2 className="text-xl sm:text-2xl font-black text-slate-900 mt-2">
                    🏷️ Tiffin Box Tagging Board
                  </h2>
                  <p className="text-xs text-slate-500 font-medium mt-1">
                    Write these exact unique codes on your tiffin container stickers with a marker pen. Riders & customers verify this code at handover.
                  </p>
                </div>

                {/* Shift Slot Selector (strictly Lunch vs Dinner) */}
                <div className="flex items-center gap-1.5 bg-slate-100 p-1.5 rounded-2xl border border-slate-200/80 shrink-0">
                  <button
                    type="button"
                    onClick={() => setTagFilterSlot('lunch')}
                    className={`px-3.5 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer ${
                      tagFilterSlot === 'lunch'
                        ? 'bg-amber-500 text-white shadow-sm shadow-amber-500/20'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <span>☀️ Lunch</span>
                    <span className="text-[10px] opacity-80 font-normal hidden sm:inline">(11am–1:30pm)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTagFilterSlot('dinner')}
                    className={`px-3.5 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer ${
                      tagFilterSlot === 'dinner'
                        ? 'bg-slate-900 text-white shadow-sm shadow-slate-900/20'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <span>🌙 Dinner</span>
                    <span className="text-[10px] opacity-80 font-normal hidden sm:inline">(7:30pm–9:30pm)</span>
                  </button>
                </div>
              </div>

              {/* Quick Metrics Bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-100">
                <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200/60">
                  <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Total Boxes</span>
                  <div className="text-xl font-black text-slate-900 mt-0.5">{boxItems.length}</div>
                </div>
                <div className="bg-emerald-50 p-3 rounded-2xl border border-emerald-200/60">
                  <span className="text-[10px] font-black uppercase tracking-wider text-emerald-600">Pure Veg Boxes</span>
                  <div className="text-xl font-black text-emerald-900 mt-0.5">{totalVeg}</div>
                </div>
                <div className="bg-rose-50 p-3 rounded-2xl border border-rose-200/60">
                  <span className="text-[10px] font-black uppercase tracking-wider text-rose-600">Non-Veg Boxes</span>
                  <div className="text-xl font-black text-rose-900 mt-0.5">{totalNonVeg}</div>
                </div>
                <div className="bg-amber-50 p-3 rounded-2xl border border-amber-200/60">
                  <span className="text-[10px] font-black uppercase tracking-wider text-amber-700">Tagged & Packed</span>
                  <div className="text-xl font-black text-amber-900 mt-0.5">{totalPacked} / {boxItems.length}</div>
                </div>
              </div>
            </div>

            {/* Prominent Rider Handover PIN & Status Banner */}
            {hasTiffinsForSlot && (isBatchReady || handoverOTP || activePickupTrip || isHandoverDone || isTagDelivered) && (
              <div
                className={`rounded-3xl p-5 sm:p-6 border-2 shadow-sm space-y-4 animate-scale-up ${
                  isTagDelivered
                    ? 'bg-gradient-to-r from-emerald-50 via-teal-50 to-emerald-50 border-emerald-300'
                    : isHandoverDone
                    ? 'bg-gradient-to-r from-blue-50 via-indigo-50 to-blue-50 border-blue-300'
                    : 'bg-gradient-to-r from-emerald-50 via-teal-50 to-emerald-50 border-emerald-300'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-11 h-11 rounded-2xl text-white flex items-center justify-center font-black shadow-sm shrink-0 ${
                        isTagDelivered
                          ? 'bg-emerald-600'
                          : isHandoverDone
                          ? 'bg-blue-600'
                          : 'bg-emerald-600'
                      }`}
                    >
                      {isTagDelivered ? (
                        <CheckCircle className="w-6 h-6" />
                      ) : isHandoverDone ? (
                        <Truck className="w-6 h-6" />
                      ) : (
                        <CheckCircle className="w-6 h-6" />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full ${
                            isTagDelivered
                              ? 'bg-emerald-200/80 text-emerald-900'
                              : isHandoverDone
                              ? 'bg-blue-200/80 text-blue-900'
                              : 'bg-emerald-200/80 text-emerald-900'
                          }`}
                        >
                          {isTagDelivered
                            ? `${tagFilterSlot.toUpperCase()} DELIVERED`
                            : isHandoverDone
                            ? `${tagFilterSlot.toUpperCase()} OUT FOR DELIVERY`
                            : `${tagFilterSlot.toUpperCase()} DISPATCH READY`}
                        </span>
                        <span
                          className={`text-[10px] font-bold ${
                            isHandoverDone ? 'text-blue-700' : 'text-emerald-700'
                          }`}
                        >
                          All {boxItems.length} Tiffins Tagged
                        </span>
                      </div>
                      <h3 className="text-base sm:text-lg font-black text-slate-900 leading-tight mt-0.5">
                        {isTagDelivered
                          ? 'Tiffins Delivered to Customer 🎉'
                          : isHandoverDone
                          ? 'Tiffin Handover Done — Out for Delivery 🛵'
                          : 'Handover Tiffins to Rider'}
                      </h3>
                    </div>
                  </div>

                  {/* Status Indicator / PIN */}
                  {isTagDelivered ? (
                    <div className="bg-white rounded-2xl p-3 sm:px-6 sm:py-2.5 border border-emerald-200 shadow-sm flex items-center justify-between sm:justify-start gap-3">
                      <div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-emerald-800 block">
                          Delivery Status
                        </span>
                        <span className="text-xs font-black text-emerald-600">DELIVERED ✓</span>
                      </div>
                      <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-black">
                        <CheckCircle className="w-5 h-5" />
                      </div>
                    </div>
                  ) : isHandoverDone ? (
                    <div className="bg-white rounded-2xl p-3 sm:px-6 sm:py-2.5 border border-blue-200 shadow-sm flex items-center justify-between sm:justify-start gap-3">
                      <div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-blue-800 block">
                          Handover Status
                        </span>
                        <span className="text-xs font-black text-blue-600">VERIFIED ✓</span>
                      </div>
                      <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-black">
                        <Truck className="w-5 h-5 animate-pulse" />
                      </div>
                    </div>
                  ) : (
                    /* Giant Monospace 4-Digit Handover PIN - only shown BEFORE handover */
                    <div className="bg-white rounded-2xl p-3 sm:px-6 sm:py-2.5 border border-emerald-200 shadow-sm flex items-center justify-between sm:justify-start gap-4">
                      <div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-emerald-800 block">
                          Rider Handover PIN
                        </span>
                        <span className="text-[10px] font-semibold text-slate-400">
                          Read code to rider
                        </span>
                      </div>
                      <div className="font-mono font-black text-3xl sm:text-4xl text-emerald-600 tracking-[0.25em] bg-emerald-50 px-3 py-1 rounded-xl border border-emerald-100">
                        {handoverOTP || '----'}
                      </div>
                    </div>
                  )}
                </div>

                {/* Rider Details Bar */}
                <div
                  className={`bg-white/90 backdrop-blur-xs rounded-2xl p-3.5 border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                    isHandoverDone ? 'border-blue-200/70' : 'border-emerald-200/70'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-brand flex items-center justify-center font-black shrink-0">
                      <Truck className="w-4 h-4 text-brand" />
                    </div>
                    <div>
                      <p className="text-xs font-black text-slate-900 flex items-center gap-2">
                        <span>{activePickupTrip?.riderName || 'Salary Fleet Rider'}</span>
                        <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">
                          {activePickupTrip?.vehicleNumber || 'Motorcycle'}
                        </span>
                      </p>
                      <p
                        className={`text-[11px] font-semibold mt-0.5 ${
                          isTagDelivered
                            ? 'text-emerald-700'
                            : isHandoverDone
                            ? 'text-blue-700'
                            : 'text-emerald-700'
                        }`}
                      >
                        {isTagDelivered
                          ? '✅ Meal successfully delivered to customer!'
                          : isHandoverDone
                          ? '🛵 Handover Complete — Rider en route to customers'
                          : activePickupTrip?.status === 'picking_up'
                          ? '🛵 Rider arrived at kitchen counter!'
                          : '🛵 Assigned Rider En Route for Pickup'}
                      </p>
                    </div>
                  </div>

                  {activePickupTrip?.riderPhone && (
                    <a
                      href={`tel:${activePickupTrip.riderPhone}`}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-1.5 shadow-sm shadow-emerald-600/20 active:scale-95 transition-all self-start sm:self-auto cursor-pointer"
                    >
                      <Phone className="w-3.5 h-3.5" /> Call Rider
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Digital Box Tag Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {boxItems.length === 0 ? (
                <div className="col-span-full bg-white rounded-3xl p-10 border border-slate-200/80 text-center shadow-xs space-y-3">
                  <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center text-slate-400 mx-auto">
                    <Tag className="w-6 h-6" />
                  </div>
                  <h4 className="font-black text-sm text-slate-900">
                    No {tagFilterSlot.toUpperCase()} Boxes to Tag
                  </h4>
                  <p className="text-xs text-slate-500 font-medium max-w-sm mx-auto">
                    There are no active subscriptions scheduled for {tagFilterSlot.toUpperCase()} preparation today.
                  </p>
                </div>
              ) : (
                boxItems.map((item, idx) => {
                  const { sub, key, slotLabel, slotType, isVeg } = item;
                  const manifest = getBoxManifest(sub);
                  const boxTag = generateBoxTag({
                    customerName: sub.userName || sub.name || 'Customer',
                    vendorName: vendorProfile?.kitchen_name || vendorProfile?.name || 'Kitchen',
                    sequenceNumber: idx + 1,
                    planType: sub.plan_type || sub.planType || 'weekly',
                    cycleNumber: sub.cycle_number || 1,
                    orderId: sub.id
                  });
                  const isPacked = packedBoxes[key];

                  return (
                    <div 
                      key={key}
                      className={`bg-white rounded-3xl p-5 border transition-all relative overflow-hidden flex flex-col justify-between gap-4 ${
                        isPacked 
                          ? 'border-emerald-300 ring-2 ring-emerald-400/20 bg-emerald-50/10' 
                          : 'border-slate-200/80 shadow-[0_4px_24px_rgba(15,23,42,0.04)]'
                      }`}
                    >
                      {/* Top Tag Bar */}
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-3">
                          <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Box #{String(idx + 1).padStart(2, '0')} • {slotType.toUpperCase()}
                          </span>
                          <DietaryBadge type={isVeg ? 'veg' : 'non_veg'} size={14} />
                        </div>

                        {/* Giant Readable Tag Code */}
                        <div className="bg-slate-900 text-white rounded-2xl p-4 text-center tracking-widest font-mono font-black text-2xl shadow-inner border border-slate-800">
                          {boxTag}
                        </div>
                        <p className="text-[10px] text-center font-bold text-slate-400 mt-1.5 uppercase tracking-wider">
                          Marker Code for Box Sticker
                        </p>
                      </div>

                      {/* Customer & Meal Specs */}
                      <div className="bg-slate-50 border border-slate-200/60 rounded-2xl p-3.5 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-black text-sm text-slate-900">{sub.userName || sub.name || 'Customer'}</span>
                          <span className="text-[10px] font-black uppercase tracking-wider bg-white border border-slate-200 px-2 py-0.5 rounded-lg text-slate-700">
                            {(sub.plan_type || sub.plan_name || 'Weekly').toUpperCase()} • C{sub.cycle_number || 1}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 font-medium flex items-center gap-1">
                          <Phone className="w-3 h-3 text-slate-400" /> {sub.userPhone || sub.phone || 'No phone'}
                        </p>
                        <p className="text-xs text-brand font-bold">
                          Slot: {slotLabel}
                        </p>
                      </div>

                      {/* Kitchen Box Packing Manifest */}
                      <div className={`p-3.5 rounded-2xl border transition-all ${
                        manifest.isCustomized 
                          ? 'bg-amber-500/10 border-amber-300 ring-1 ring-amber-400/30' 
                          : 'bg-slate-50/80 border-slate-200/60'
                      }`}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[10px] font-black uppercase tracking-wider text-slate-500 flex items-center gap-1">
                            📦 Kitchen Box Manifest
                          </span>
                          {manifest.isCustomized ? (
                            <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500 text-white shadow-xs">
                              Custom Portions
                            </span>
                          ) : (
                            <span className="text-[9px] font-bold text-slate-400 uppercase">
                              Standard Base
                            </span>
                          )}
                        </div>
                        <p className={`text-xs font-black leading-snug ${
                          manifest.isCustomized ? 'text-amber-950' : 'text-slate-700'
                        }`}>
                          {manifest.manifestText}
                        </p>
                      </div>

                      {/* Mark Packed Action Button */}
                      <button
                        type="button"
                        onClick={() => {
                          const willBePacked = !isPacked;
                          setPackedBoxes(prev => {
                            const updated = { ...prev, [key]: willBePacked };
                            if (willBePacked) {
                              const newPackedCount = boxItems.filter(b => (b.key === key ? true : updated[b.key])).length;
                              if (newPackedCount === boxItems.length && boxItems.length > 0) {
                                setShowAllPackedModal(true);
                              }
                            }
                            return updated;
                          });
                          if (!isPacked) {
                            toast.success(`Box ${boxTag} (${slotType.toUpperCase()}) marked Tagged & Packed! ✨`);
                          }
                        }}
                        className={`w-full py-3 px-4 rounded-2xl text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 active:scale-95 cursor-pointer ${
                          isPacked
                            ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/20'
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
                        }`}
                      >
                        {isPacked ? <Check className="w-4 h-4" /> : <Tag className="w-4 h-4 text-brand" />}
                        {isPacked ? 'Box Tagged & Packed ✓' : 'Mark Tagged & Packed'}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })()}

      {/* ── TAB 2: DAILY MENU MANAGER ───────────────────────────────────── */}
      {activeTab === 'menu' && (
        <div className="animate-fade-in">
          <TodayMenuCard />
        </div>
      )}

      {/* ── TAB 3: ACTIVE SUBSCRIBERS ───────────────────────────────────── */}
      {activeTab === 'subscribers' && (
        <div className="space-y-4 animate-fade-in">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-black text-slate-900">Active Subscribers ({subscriptions.length})</h3>
            <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200">
              Auto-renewing Meal Plans
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {subscriptions.length === 0 ? (
              <div className="col-span-full bg-white rounded-3xl p-10 border border-slate-200/80 text-center shadow-xs space-y-3">
                <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center text-slate-400 mx-auto">
                  <Users className="w-6 h-6" />
                </div>
                <h4 className="font-black text-sm text-slate-900">No Active Subscribers Yet</h4>
                <p className="text-xs text-slate-500 font-medium max-w-sm mx-auto">
                  Real-time active meal plan subscriptions for this kitchen will appear here automatically.
                </p>
              </div>
            ) : (
              subscriptions.map((sub: any) => {
                const isNonVeg = sub.dietary === 'non_veg' || sub.category === 'non_veg' || (sub.meal_type as any) === 'non_veg';
                const effSlot = sub.delivery_slot || sub.deliverySlot || null;
                const slotText = effSlot === 'dinner' || (!effSlot && sub.meal_type === 'dinner')
                  ? 'Dinner (8:00 PM)'
                  : effSlot === 'lunch' || (!effSlot && sub.meal_type === 'lunch')
                  ? 'Lunch (1:00 PM)'
                  : (!effSlot && sub.meal_type === 'both')
                  ? 'Lunch & Dinner'
                  : (sub.deliveryPreference || 'Dinner (8:00 PM)');
                const subManifest = getBoxManifest(sub);
                return (
                  <div key={sub.id} className="bg-white rounded-3xl p-5 border border-slate-200/80 shadow-xs flex items-start justify-between">
                    <div className="space-y-1 flex-1 pr-3">
                      <div className="flex items-center gap-2">
                        <h4 className="font-black text-slate-900 text-base">{sub.userName || sub.name || 'Subscriber'}</h4>
                        <span className="text-[10px] font-black uppercase text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                          {sub.status || 'Active'}
                        </span>
                        {subManifest.isCustomized && (
                          <span className="text-[10px] font-black uppercase text-amber-800 bg-amber-100/70 px-2 py-0.5 rounded-full border border-amber-300">
                            Custom Portions
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-bold text-brand uppercase">{sub.plan_name || `${sub.meal_type} Plan`} • {isNonVeg ? 'Non-Veg' : 'Pure Veg'}</p>
                      <p className="text-xs text-slate-500 flex items-center gap-1 mt-1"><Phone className="w-3 h-3 text-slate-400" /> {sub.userPhone || sub.phone || 'No phone'}</p>
                      <p className="text-xs text-slate-400">Slot: {slotText}</p>
                      {subManifest.isCustomized && (
                        <div className="mt-2 p-2 bg-amber-50/70 rounded-xl border border-amber-200/60 text-xs">
                          <span className="font-black text-amber-900 block text-[10px] uppercase tracking-wider">📦 Custom Box Manifest:</span>
                          <span className="text-amber-800 text-[11px] font-medium leading-tight">{subManifest.manifestText}</span>
                        </div>
                      )}
                    </div>
                    <div className="w-10 h-10 rounded-2xl bg-amber-50 text-brand flex items-center justify-center font-bold text-sm shrink-0">
                      {(sub.userName || sub.name || 'S')[0].toUpperCase()}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ── TAB 4: MEAL RATES & PRICING ─────────────────────────────────── */}
      {activeTab === 'rates' && (
        <div className="animate-fade-in">
          <MealRatesCard />
        </div>
      )}

      {/* Date Details Modal */}
      {selectedDateDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden animate-slide-up relative p-6">
            <button 
              onClick={() => setSelectedDateDetails(null)}
              className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center bg-slate-100 text-slate-500 rounded-full hover:bg-slate-200 font-bold"
            >✕</button>

            <h3 className="text-xl font-black text-slate-900 mb-1">{selectedDateDetails.displayDate}</h3>
            <p className="text-xs font-semibold text-slate-400 mb-6">Meal prep forecast breakdown</p>
            
            <div className="space-y-3">
              {selectedDateDetails.details.length === 0 ? (
                <div className="bg-slate-50 rounded-2xl p-6 text-center border border-slate-200/80">
                  <p className="text-sm font-bold text-slate-600">No tiffins scheduled for this date</p>
                  <p className="text-xs text-slate-400 mt-1">Current subscription period does not cover this day.</p>
                </div>
              ) : (
                selectedDateDetails.details.map((prep: any, idx: number) => (
                  <div key={idx} className="bg-slate-50 rounded-2xl p-4 border border-slate-200/80 flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-black uppercase tracking-wider text-brand bg-brand/10 px-2.5 py-0.5 rounded-full">
                        {prep.mealType?.toUpperCase() || 'LUNCH'}
                      </span>
                      <h4 className="font-black text-slate-900 text-lg mt-1.5">
                        {prep.count} Tiffins Scheduled
                      </h4>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Slot: <span className="font-bold text-slate-700">
                          {prep.slot === "11am" || prep.mealType === "lunch" ? "Lunch (1:00 PM Delivery)" : prep.slot === "8pm" || prep.mealType === "dinner" ? "Dinner (8:00 PM Delivery)" : prep.slot}
                        </span>
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Superadmin Location Update Modal */}
      <UpdateVendorLocationModal
        isOpen={isLocationModalOpen}
        onClose={() => setIsLocationModalOpen(false)}
        vendor={vendorProfile}
      />

      {/* ── ALL BOXES PACKED CONFIRMATION MODAL ─────────────────────────── */}
      {showAllPackedModal && (() => {
        const activeSlotSubs = subscriptions.filter((s: any) => {
          const effSlot = s.delivery_slot || s.deliverySlot || null;
          return tagFilterSlot === 'lunch'
            ? (effSlot === 'lunch' || effSlot === 'both' || (!effSlot && (s.meal_type === 'lunch' || s.meal_type === 'both' || !s.meal_type)))
            : (effSlot === 'dinner' || effSlot === 'both' || (!effSlot && (s.meal_type === 'dinner' || s.meal_type === 'both')));
        });
        const activeVegCount = activeSlotSubs.filter((s: any) => s.dietary !== 'non_veg' && s.category !== 'non_veg' && s.meal_type !== 'non_veg').length;
        const activeNonVegCount = activeSlotSubs.length - activeVegCount;
        const activeBatch = todayBatches.find((b: any) => {
          const bSlot = (b.slot || '').toLowerCase();
          return tagFilterSlot === 'lunch'
            ? (bSlot === 'lunch' || bSlot === '11am' || bSlot === '1pm')
            : (bSlot === 'dinner' || bSlot === '8pm' || bSlot === '7pm');
        });

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
            <div 
              className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 space-y-5 animate-scale-up"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-2xl bg-emerald-500/10 text-emerald-600 flex items-center justify-center shrink-0">
                    <CheckCircle className="w-6 h-6 text-emerald-600" />
                  </div>
                  <div>
                    <span className="text-[10px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                      Shift Milestone Reached
                    </span>
                    <h3 className="text-base sm:text-lg font-black text-slate-900 leading-tight mt-0.5">
                      All {tagFilterSlot.toUpperCase()} Tiffins Packed!
                    </h3>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAllPackedModal(false)}
                  className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3">
                <p className="text-xs text-slate-600 font-medium leading-relaxed">
                  You have marked all <strong className="text-slate-900 font-bold">{activeSlotSubs.length} tiffin containers</strong> for today's {tagFilterSlot.toUpperCase()} shift as tagged and packed.
                </p>

                {/* Summary Checklist */}
                <div className="bg-slate-50 rounded-2xl p-3.5 border border-slate-200/60 space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                    <span>Total Packed Boxes:</span>
                    <span className="font-black text-slate-900">{activeSlotSubs.length} Tiffins</span>
                  </div>
                  <div className="flex items-center justify-between text-xs font-bold text-emerald-700">
                    <span>Pure Veg 🟢:</span>
                    <span className="font-black">{activeVegCount} Boxes</span>
                  </div>
                  <div className="flex items-center justify-between text-xs font-bold text-rose-700">
                    <span>Non-Veg 🔴:</span>
                    <span className="font-black">{activeNonVegCount} Boxes</span>
                  </div>
                </div>

                <div className="bg-amber-50 rounded-2xl p-3 border border-amber-200/80 flex items-start gap-2">
                  <Sparkles className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-amber-800 font-medium leading-normal">
                    Confirming dispatch will notify the assigned delivery rider and unlock your <strong>4-digit Handover PIN</strong> for counter pickup.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAllPackedModal(false)}
                  className="px-4 py-2.5 rounded-xl text-xs font-bold text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 transition-all cursor-pointer"
                >
                  Review Boxes
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setShowAllPackedModal(false);
                    if (activeBatch) {
                      await handleMarkReady(activeBatch);
                    } else {
                      toast.success(`All ${tagFilterSlot.toUpperCase()} tiffins confirmed ready! Handover PIN unlocked.`);
                    }
                  }}
                  className="px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider text-white bg-emerald-600 hover:bg-emerald-700 shadow-md shadow-emerald-600/20 transition-all flex items-center gap-2 active:scale-95 cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  <span>Ready for Dispatch</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Today's Orders drill-down modal */}
      {prepModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-6" role="dialog" aria-modal="true" aria-label="Today's orders">
          <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[85vh] flex flex-col overflow-hidden animate-fade-in">
            <div className="flex items-center justify-between p-5 border-b border-slate-100 shrink-0">
              <div>
                <h3 className="text-sm font-black text-slate-900 flex items-center gap-2">
                  <PackageCheck className="w-4 h-4 text-brand" />
                  Today's Orders
                </h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mt-0.5">
                  {prepOrders ? `${prepOrders.length} tiffin${prepOrders.length === 1 ? '' : 's'}` : 'Loading…'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPrepModalOpen(false)}
                aria-label="Close orders"
                className="w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center active:scale-95 transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="overflow-y-auto p-4 space-y-2.5">
              {loadingPrepOrders && (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                  <Loader2 className="w-6 h-6 text-brand animate-spin" />
                  <p className="text-xs font-bold text-slate-400">Fetching today's orders…</p>
                </div>
              )}

              {!loadingPrepOrders && prepOrders && prepOrders.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
                  <PackageCheck className="w-8 h-8 text-slate-300" />
                  <p className="text-xs font-bold text-slate-400">No orders found for today.</p>
                </div>
              )}

              {!loadingPrepOrders && prepOrders && prepOrders.map((row: any) => {
                const attention = ['cancelled', 'failed', 'skipped', 'swapped_out'].includes(row.status);
                return (
                  <div key={row.id} className="rounded-2xl border border-slate-200/80 p-3.5 flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-[10px] font-black shrink-0 ${attention ? 'bg-red-50 text-red-600' : 'bg-slate-900 text-white'}`}>
                      #{String(row.id).slice(-5)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-black text-[13px] text-slate-900 leading-tight truncate">
                          {row.customerName || 'Walk-in / Unknown'}
                        </p>
                        <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full ${attention ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>
                          {row.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 font-medium truncate mt-0.5">
                        {row.mealType ? `${String(row.mealType).replace(/_/g, ' ')} · ` : ''}
                        {row.addressLine || 'Doorstep'}
                      </p>
                      <p className="text-[10px] font-mono text-slate-400 truncate mt-0.5">
                        #{row.id}{row.riderName ? ` · Rider: ${row.riderName}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {row.customerPhone && (
                        <a
                          href={`tel:${row.customerPhone}`}
                          aria-label={`Call ${row.customerName || 'customer'}`}
                          className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center justify-center active:scale-95 transition-all"
                        >
                          <Phone className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Custom Confirmation Dialog */}
      <ConfirmDialog
        isOpen={confirmConfig.isOpen}
        title={confirmConfig.title}
        message={confirmConfig.message}
        confirmLabel={confirmConfig.confirmLabel}
        variant={confirmConfig.variant}
        onConfirm={confirmConfig.onConfirm}
        onCancel={() => setConfirmConfig(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
}
