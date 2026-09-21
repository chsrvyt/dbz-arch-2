'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { useAuthStore } from '@/store/authStore';
import { useUiStore } from '@/store/uiStore';
import { getUserById } from '@/lib/queries/users';
import { getVendorReviews, addReview, editReview } from '@/lib/queries/reviews';
import { getDocs, collection, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { getUserSubscriptions } from '@/lib/queries/subscriptions';
import { isSubscriptionActive } from '@dabzzo/shared-lib/subscriptionEntitlement';
import { validateDiscountCode } from '@/lib/queries/discounts';
import { getImageUrl } from '@/lib/storage';
import { formatDate, cn } from '@/lib/utils';
import { SkeletonCard } from '@/components/shared/Skeleton';
import { EmptyState } from '@/components/shared/EmptyState';
import { SubscriptionOnboardingModal } from '@/components/subscription/SubscriptionOnboardingModal';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import type { AppUser, Review, DiscountCode, SubscriptionFrequency, DietaryCategory } from '@/types';
import { Star, ChevronLeft, MapPin, Utensils, MessageSquare, Plus, CheckCircle2, Tag, Loader2, X, Calendar, Clock, RotateCcw, AlertCircle, Clipboard, Sparkles, ArrowRight, Sliders } from 'lucide-react';
import { VegIcon, NonVegIcon } from '@/components/shared/DietaryIcon';

function StarSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-1.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          className="transition-all duration-150 hover:scale-115 active:scale-95"
        >
          <Star 
            className={`w-7 h-7 ${star <= value ? 'fill-amber-400 text-amber-400' : 'text-slate-200 hover:text-amber-200'}`} 
          />
        </button>
      ))}
    </div>
  );
}

export default function VendorDetailPage() {
  const searchParams = useSearchParams();
  const vendorId = searchParams.get('id') || '';
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const addToast = useUiStore((s) => s.addToast);

  const [vendor, setVendor] = useState<AppUser | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [myReview, setMyReview] = useState<Review | null>(null);
  const [rating, setRating] = useState(0);
  const [reviewText, setReviewText] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [editingReview, setEditingReview] = useState(false);
  const [todayMenu, setTodayMenu] = useState<any>(null);
  const [userSubs, setUserSubs] = useState<string[]>([]);
  const [totalActiveSubs, setTotalActiveSubs] = useState(0);
  
  // Dietary Category selection state
  const [selectedCategory, setSelectedCategory] = useState<DietaryCategory>('veg');

  // Promo code state
  const [promoInput, setPromoInput] = useState('');
  const [validatingPromo, setValidatingPromo] = useState(false);
  const [appliedDiscount, setAppliedDiscount] = useState<DiscountCode | null>(null);

  // Subscription Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalInitialPlanId, setModalInitialPlanId] = useState('');
  const [modalInitialStep, setModalInitialStep] = useState(1);
  const [subscribing, setSubscribing] = useState<string | null>(null);

  // Frequency selector state
  const [selectedFrequency, setSelectedFrequency] = useState<SubscriptionFrequency>('one-time');
  const [showDowngradeModal, setShowDowngradeModal] = useState(false);

  useEffect(() => { 
    if (vendorId) {
      loadAll(); 
    }
  }, [vendorId]);

  async function loadAll() {
    setLoading(true);
    try {
      const [v, revs] = await Promise.all([
        getUserById(vendorId),
        getVendorReviews(vendorId),
      ]);
      setVendor(v);
      setReviews(revs);
      const mine = user ? revs.find((r) => r.user_id === user.id) ?? null : null;
      setMyReview(mine);
      if (mine) { setRating(mine.rating); setReviewText(mine.review_text ?? ''); }

      if (v?.dietary_categories && !v.dietary_categories.includes('veg') && v.dietary_categories.includes('non_veg')) {
        setSelectedCategory('non_veg');
      } else {
        setSelectedCategory('veg');
      }

      // Fetch Today's Menu
      try {
        const todayStr = new Date().toISOString().split('T')[0];
        const menuSnap = await getDocs(
          query(collection(db, 'daily_menus'), where('vendor_id', '==', vendorId), where('date', '==', todayStr))
        );
        if (!menuSnap.empty) {
          setTodayMenu(menuSnap.docs[0].data());
        }
      } catch (err) {
        console.warn('Could not load today menu:', err);
      }

      // Fetch Vendor Active Subscriptions Count (entitlement-aware)
      try {
        const subsSnap = await getDocs(
          query(collection(db, 'subscriptions'), where('vendor_id', '==', vendorId), where('status', '==', 'active'))
        );
        const nowMs = Date.now();
        setTotalActiveSubs(
          subsSnap.docs.filter((d) => isSubscriptionActive(d.data() as any, nowMs)).length
        );
      } catch (err) {
        console.warn('Could not fetch active subs count:', err);
      }

      // If user is logged in, fetch their existing subscriptions for this vendor
      if (user) {
        const mySubs = await getUserSubscriptions(user.id);
        const activeVendorSubs = mySubs
          .filter((s) => s.vendor_id === vendorId && isSubscriptionActive(s as any))
          .map((s) => s.meal_type);
        setUserSubs(activeVendorSubs);
      }
    } catch (err) {
      addToast('Failed to load kitchen profile', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleReviewSubmit() {
    if (!user) { addToast('Please sign in to leave a review', 'warning'); router.push('/login'); return; }
    if (rating === 0) { addToast('Please select a star rating', 'warning'); return; }
    if (!reviewText.trim()) { addToast('Please write a brief feedback note', 'warning'); return; }

    setSubmittingReview(true);
    try {
      if (myReview) {
        await editReview(myReview.id, rating, reviewText.trim());
        addToast('Review updated! Thank you.', 'success');
      } else {
        await addReview(vendorId, user.id, user.name || 'Foodie', rating, reviewText.trim());
        addToast('Review posted! Thank you.', 'success');
      }
      setEditingReview(false);
      const revs = await getVendorReviews(vendorId);
      setReviews(revs);
      const mine = revs.find((r) => r.user_id === user.id) ?? null;
      setMyReview(mine);
    } catch (err) {
      addToast('Failed to submit review', 'error');
    } finally {
      setSubmittingReview(false);
    }
  }

  async function handleApplyPromo() {
    if (!promoInput.trim()) return;
    setValidatingPromo(true);
    try {
      const discount = await validateDiscountCode(promoInput.trim(), vendorId);
      if (discount) {
        setAppliedDiscount(discount);
        addToast(`Success! ${discount.discount_pct}% off applied.`, 'success');
      } else {
        addToast('Invalid or expired promo code', 'error');
      }
    } catch (err) {
      addToast('Failed to validate promo code', 'error');
    } finally {
      setValidatingPromo(false);
    }
  }

  async function handleSubscribe(planId: string) {
    if (!user) { addToast('Please sign in to subscribe', 'warning'); router.push('/login'); return; }
    
    // Restriction logic: Cannot subscribe to anything else if 'both' is active
    if (userSubs.includes('both') && planId !== 'both') {
      setShowDowngradeModal(true);
      return;
    }

    setModalInitialPlanId(planId);
    setModalInitialStep(1);
    setIsModalOpen(true);
  }

  async function handleCustomizePortions(planId: string) {
    if (!user) { addToast('Please sign in to customize your plan', 'warning'); router.push('/login'); return; }
    
    if (userSubs.includes('both') && planId !== 'both') {
      setShowDowngradeModal(true);
      return;
    }

    setModalInitialPlanId(planId);
    setModalInitialStep(user?.address ? 3 : 1);
    setIsModalOpen(true);
  }

  const hasVeg = !vendor?.dietary_categories || vendor.dietary_categories.includes('veg');
  const hasNonVeg = vendor?.dietary_categories?.includes('non_veg');
  const hasBoth = hasVeg && hasNonVeg;

  // Rate calculations based on selectedCategory
  const isNonVeg = selectedCategory === 'non_veg';
  const _lunchW  = isNonVeg ? (vendor?.rate_nonveg_lunch_weekly || 0) : (vendor?.rate_veg_lunch_weekly ?? vendor?.rate_lunch_weekly ?? vendor?.rate_lunch ?? 0);
  const _lunchM  = isNonVeg ? (vendor?.rate_nonveg_lunch_monthly || 0) : (vendor?.rate_veg_lunch_monthly ?? vendor?.rate_lunch_monthly ?? vendor?.rate_lunch ?? 0);
  const _dinnerW = isNonVeg ? (vendor?.rate_nonveg_dinner_weekly || 0) : (vendor?.rate_veg_dinner_weekly ?? vendor?.rate_dinner_weekly ?? vendor?.rate_dinner ?? 0);
  const _dinnerM = isNonVeg ? (vendor?.rate_nonveg_dinner_monthly || 0) : (vendor?.rate_veg_dinner_monthly ?? vendor?.rate_dinner_monthly ?? vendor?.rate_dinner ?? 0);
  const _bothW   = isNonVeg ? (vendor?.rate_nonveg_both_weekly || 0) : (vendor?.rate_veg_both_weekly ?? vendor?.rate_both_weekly ?? vendor?.rate_both ?? 0);
  const _bothM   = isNonVeg ? (vendor?.rate_nonveg_both_monthly || 0) : (vendor?.rate_veg_both_monthly ?? vendor?.rate_both_monthly ?? vendor?.rate_both ?? 0);
  const _onetime = isNonVeg ? (vendor?.rate_nonveg_onetime || 0) : (vendor?.rate_veg_onetime ?? vendor?.rate_onetime ?? 0);

  const plans = selectedFrequency === 'one-time'
    ? (_onetime
        ? [{ id: 'one-time', label: `${isNonVeg ? 'Non-Veg ' : 'Pure Veg '}Single Meal`, price: _onetime, basePrice: _onetime, type: 'Any meal, anytime delivery', isNonVeg }]
        : [])
    : [
        (_lunchW || _lunchM) && {
          id: 'lunch',
          label: `${isNonVeg ? 'Non-Veg ' : 'Pure Veg '}Lunch Plan`,
          price: selectedFrequency === 'monthly' ? _lunchM : _lunchW,
          basePrice: _lunchW,
          type: '11:00 AM – 01:00 PM Slot',
          isNonVeg,
        },
        (_dinnerW || _dinnerM) && {
          id: 'dinner',
          label: `${isNonVeg ? 'Non-Veg ' : 'Pure Veg '}Dinner Plan`,
          price: selectedFrequency === 'monthly' ? _dinnerM : _dinnerW,
          basePrice: _dinnerW,
          type: '07:30 PM – 09:30 PM Slot',
          isNonVeg,
        },
        (_bothW || _bothM) && {
          id: 'both',
          label: `${isNonVeg ? 'Non-Veg ' : 'Pure Veg '}Lunch + Dinner Combo`,
          price: selectedFrequency === 'monthly' ? _bothM : _bothW,
          basePrice: _bothW,
          type: 'Full Day Meal Package',
          isNonVeg,
        },
      ].filter(Boolean) as { id: string; label: string; price: number; basePrice: number; type: string; isNonVeg: boolean }[];

  const avgRating = reviews.length
    ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
    : null;

  const othersReviews = reviews.filter(r => !user || r.user_id !== user.id);

  if (loading) {
    return (
      <div className="page-shell space-y-6 pt-6 max-w-md mx-auto">
        <SkeletonCard hasImage lines={3} />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </div>
    );
  }

  if (!vendor) {
    return (
      <div className="page-shell flex items-center justify-center min-h-[60vh]">
        <EmptyState icon={<AlertCircle className="w-10 h-10 text-slate-300 stroke-[1.25]" />} title="Vendor not found" action={<button className="btn-outline" onClick={() => router.back()}>Go Back</button>} />
      </div>
    );
  }

  const kitchenTitle = vendor.kitchen_name?.trim() || vendor.name;
  const showOwnerSubtitle = Boolean(
    vendor.kitchen_name?.trim() &&
    vendor.name?.trim() &&
    vendor.kitchen_name.trim().toLowerCase() !== vendor.name.trim().toLowerCase()
  );

  return (
    <div className="pb-36 animate-fade-in bg-[#FEFCE8] min-h-dvh">
      {/* Premium Hero */}
      <div className="relative h-72 w-full bg-slate-900">
        {vendor.image ? (
          <Image 
            src={getImageUrl(vendor.image)} 
            alt={kitchenTitle} 
            fill 
            className="object-cover"
            priority
          />
        ) : (
          <div className="flex items-center justify-center h-full bg-gradient-to-br from-amber-600 to-brand">
            <span className="text-7xl">🍱</span>
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/30 to-transparent" />
        
        <button
          onClick={() => router.back()}
          className="absolute top-6 left-6 w-11 h-11 rounded-2xl bg-slate-950/40 backdrop-blur-md flex items-center justify-center shadow-lg border border-white/10 text-white hover:bg-slate-950/60 transition-all active:scale-90"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>

        <div className="absolute bottom-6 left-6 right-6">
          <div className="flex items-center gap-2 mb-2">
            <div className="px-3 py-1 rounded-full bg-brand text-white text-[10px] font-black uppercase tracking-widest shadow-md">
              {vendor.cuisine_type ?? 'Home Style'}
            </div>
            {avgRating && (
              <div className="px-3 py-1 rounded-full bg-white text-slate-900 text-[10px] font-black uppercase tracking-widest shadow-md flex items-center gap-1">
                <Star className="w-3 h-3 fill-amber-400 text-amber-500" /> {avgRating}
              </div>
            )}
            <div className="px-3 py-1 rounded-full bg-emerald-500 text-white text-[10px] font-black uppercase tracking-wider shadow-md flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> Verified
            </div>
          </div>
          <h1 className="text-white text-3xl sm:text-4xl font-black tracking-tight leading-tight">
            {kitchenTitle}
          </h1>
          {showOwnerSubtitle && (
            <p className="text-amber-200/90 text-xs sm:text-sm font-semibold mt-1">
              by {vendor.name}
            </p>
          )}
          <p className="text-white/80 text-xs sm:text-sm font-medium mt-1 flex items-center gap-1.5 truncate">
            <MapPin className="w-3.5 h-3.5 shrink-0 text-brand" /> {vendor.address || (vendor as any).location?.address || 'Sector 62, Noida, Uttar Pradesh'}
          </p>
        </div>
      </div>

      <div className="max-w-xl mx-auto px-4 pt-6 space-y-6">
        
        {/* Capacity Sold Out Banner */}
        {vendor.capacity !== undefined && vendor.capacity !== null && totalActiveSubs >= vendor.capacity && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-3xl text-xs font-bold flex items-start gap-3 shadow-xs">
            <span className="text-lg shrink-0">⚠️</span>
            <div>
              <p className="uppercase tracking-wider text-[11px] font-black text-rose-900">Kitchen at Capacity</p>
              <p className="font-medium text-rose-700 mt-0.5 leading-relaxed">
                This kitchen has reached its maximum subscription capacity. Check back soon for opening slots.
              </p>
            </div>
          </div>
        )}

        {/* Dietary Category Toggle (Veg vs Non-Veg) */}
        {hasBoth && (
          <div className="bg-white p-1.5 rounded-2xl border border-slate-200/80 shadow-xs grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedCategory('veg')}
              className={`py-3 px-4 rounded-xl text-xs font-black flex items-center justify-center gap-2 transition-all ${
                selectedCategory === 'veg'
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200 shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <VegIcon size={16} /> Pure Veg Plans
            </button>
            <button
              type="button"
              onClick={() => setSelectedCategory('non_veg')}
              className={`py-3 px-4 rounded-xl text-xs font-black flex items-center justify-center gap-2 transition-all ${
                selectedCategory === 'non_veg'
                  ? 'bg-rose-50 text-rose-800 border border-rose-200 shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <NonVegIcon size={16} /> Non-Veg Plans
            </button>
          </div>
        )}

        {/* Today's Special Menu Card */}
        {todayMenu && (() => {
          const activeSpecialItems = (selectedCategory === 'non_veg'
            ? todayMenu.items_non_veg
            : (todayMenu.items_veg && todayMenu.items_veg.length > 0 ? todayMenu.items_veg : todayMenu.items)
          ) || [];
          const activeSpecialNote = selectedCategory === 'non_veg' ? todayMenu.note_non_veg : (todayMenu.note_veg || todayMenu.note);

          if (activeSpecialItems.length === 0 && !activeSpecialNote) return null;

          return (
            <div className="rounded-3xl overflow-hidden bg-white border border-slate-200/80 shadow-xs">
              <div className="bg-slate-900 px-5 py-3.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {selectedCategory === 'non_veg' ? <NonVegIcon size={16} /> : <VegIcon size={16} />}
                  <h3 className="text-white font-black text-xs uppercase tracking-wider">
                    {selectedCategory === 'non_veg' ? 'Non-Veg Special of the Day' : 'Pure Veg Special of the Day'}
                  </h3>
                </div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  {todayMenu.date}
                </span>
              </div>
              <div className="p-5">
                <div className="space-y-2.5">
                  {activeSpecialItems.map((item: any, i: number) => (
                    <div key={i} className="flex items-start gap-3">
                      <CheckCircle2 className="w-4 h-4 text-brand mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-bold text-slate-800 leading-tight">
                          {item.name}
                        </p>
                        {item.description && (
                          <span className="block text-xs font-medium text-slate-400 mt-0.5">{item.description}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {activeSpecialNote && (
                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-start gap-2">
                    <p className="text-xs text-slate-500 italic leading-relaxed">“{activeSpecialNote}”</p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Promo Code Section */}
        <div>
          {appliedDiscount ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-3xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-emerald-500 flex items-center justify-center text-white shadow-xs">
                  <Tag className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-emerald-700 uppercase tracking-widest">Promo Applied</p>
                  <p className="text-sm font-black text-slate-900">{appliedDiscount.code} • {appliedDiscount.discount_pct}% OFF</p>
                </div>
              </div>
              <button 
                onClick={() => { setAppliedDiscount(null); setPromoInput(''); }}
                className="w-8 h-8 rounded-full bg-white flex items-center justify-center text-slate-400 hover:text-rose-500 transition-colors shadow-xs"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Tag className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Enter Promo Code"
                  className="w-full bg-white border border-slate-200/80 rounded-2xl pl-11 pr-4 py-3.5 text-xs font-black uppercase tracking-wider outline-none focus:border-brand transition-all placeholder:text-slate-400 placeholder:font-medium"
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                />
              </div>
              <button
                onClick={handleApplyPromo}
                disabled={validatingPromo || !promoInput.trim()}
                className="bg-slate-900 hover:bg-slate-800 text-white px-5 rounded-2xl text-xs font-black uppercase tracking-wider disabled:opacity-50 transition-all flex items-center justify-center min-w-[90px]"
              >
                {validatingPromo ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Apply'}
              </button>
            </div>
          )}
        </div>

        {/* ── MEAL PLANS SECTION ───────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-black text-slate-900 tracking-tight">Select Meal Plan</h2>
                <p className="text-xs font-semibold text-slate-400">Choose single meal or recurring subscription</p>
                <p className="text-xs font-semibold text-slate-400">Choose standard plan, customize portions, or build a custom schedule</p>
              </div>
            </div>

            {/* Custom Meal Plan Promotional Hero Card */}
            <div className="bg-gradient-to-r from-amber-500/15 via-orange-500/10 to-amber-50/80 rounded-3xl p-5 border-2 border-amber-300 shadow-sm space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3.5">
                  <div className="w-12 h-12 rounded-2xl bg-amber-500 text-white flex items-center justify-center font-black shadow-md shrink-0">
                    <Sparkles className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-black text-slate-900 leading-tight">Need a Custom Schedule or Portions?</h3>
                      <span className="bg-amber-200/90 text-amber-950 text-[10px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border border-amber-300">
                        Full Flexibility
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 font-medium mt-1 leading-relaxed">
                      Pick specific days of the week, skip weekends, or adjust rotis, dal, and rice portions to your exact appetite with {kitchenTitle}.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-amber-200/60">
                <div className="flex items-center gap-2.5 text-[11px] font-extrabold text-amber-900 flex-wrap">
                  <span className="flex items-center gap-1">✓ Pick Custom Days</span>
                  <span className="flex items-center gap-1">✓ Tailor Thali Portions</span>
                  <span className="flex items-center gap-1">✓ Live Margin Pricing</span>
                </div>
                <Link
                  href={`/custom-plan?vendorId=${vendorId}&freq=${selectedFrequency === 'weekly' ? 'weekly' : 'monthly'}`}
                  className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-black uppercase tracking-wider rounded-xl transition-all shadow-md active:scale-95 flex items-center justify-center gap-1.5 self-start sm:self-auto"
                >
                  <span>Build Custom Plan</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            </div>
            
            {/* Frequency Selector */}
            <div className="bg-white p-1.5 rounded-2xl border border-slate-200/80 shadow-xs flex flex-wrap gap-1">
              {(['one-time', 'weekly', 'monthly'] as SubscriptionFrequency[]).map(freq => (
                <button
                  key={freq}
                  onClick={() => setSelectedFrequency(freq)}
                  className={`flex-1 py-2.5 px-3 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 ${
                    selectedFrequency === freq 
                      ? 'bg-slate-900 text-white shadow-xs' 
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {freq === 'one-time' && <Clock className="w-3.5 h-3.5" />}
                  {freq === 'weekly' && <RotateCcw className="w-3.5 h-3.5" />}
                  {freq === 'monthly' && <Calendar className="w-3.5 h-3.5" />}
                  {freq.replace('-', ' ')}
                </button>
              ))}
              <Link
                href={`/custom-plan?vendorId=${vendorId}&freq=${selectedFrequency === 'weekly' ? 'weekly' : 'monthly'}`}
                className="flex-1 py-2.5 px-3 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 bg-amber-50 text-amber-900 hover:bg-amber-100 border border-amber-200/80"
              >
                <Sparkles className="w-3.5 h-3.5 text-brand" />
                <span>Custom Days</span>
              </Link>
            </div>
          </div>

          {plans.length === 0 ? (
            <EmptyState icon={<Clipboard className="w-10 h-10 text-slate-300 stroke-[1.25]" />} title="No plans available" description="This kitchen has not published active rate cards." />
          ) : (
            <div className="space-y-3">
              {plans.map((plan) => {
                const isSoldOut = vendor.capacity !== undefined && vendor.capacity !== null && totalActiveSubs >= vendor.capacity;
                const isSubscribed = userSubs.includes(plan.id);
                const isBtnDisabled = subscribing === plan.id || isSubscribed || (isSoldOut && !isSubscribed);
                const discountAmount = appliedDiscount ? (plan.price * appliedDiscount.discount_pct) / 100 : 0;
                const finalPrice = plan.price - discountAmount;

                return (
                  <div key={plan.id} className="bg-white rounded-3xl p-5 border border-slate-200/80 shadow-[0_4px_20px_rgba(15,23,42,0.03)] hover:border-amber-300 transition-all">
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                      
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div className={cn(
                          "w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-xs",
                          plan.id === 'lunch' ? 'bg-amber-50 text-amber-600 border border-amber-200/70' : 
                          plan.id === 'dinner' ? 'bg-indigo-50 text-indigo-600 border border-indigo-200/70' : 
                          'bg-amber-500/10 text-brand border border-amber-500/20'
                        )}>
                          {plan.id === 'lunch' ? <Clock className="w-5 h-5" /> : plan.id === 'dinner' ? <Clock className="w-5 h-5" /> : <Utensils className="w-5 h-5" />}
                        </div>
                        
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {plan.isNonVeg ? <NonVegIcon size={15} /> : <VegIcon size={15} />}
                            <h3 className="font-black text-slate-900 text-base leading-tight text-pretty">
                              {plan.label}
                            </h3>
                          </div>
                          <p className="text-xs font-medium text-slate-400 mt-0.5">
                            {plan.type}
                          </p>
                          <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold text-slate-500 mt-1">
                            <span className="bg-slate-100 px-2 py-0.5 rounded-md text-slate-700">4× Roti • 1× Rice • 1× Sabzi • 1× Dal</span>
                            <span className="text-amber-700 font-bold hidden sm:inline">• Adjustable Portions</span>
                          </div>
                          <div className="flex items-baseline gap-1.5 mt-1.5">
                            {appliedDiscount ? (
                              <>
                                <span className="text-xl font-black text-emerald-600">₹{finalPrice}</span>
                                <span className="text-xs font-bold text-slate-300 line-through">₹{plan.price}</span>
                              </>
                            ) : (
                              <span className="text-xl font-black text-slate-900">₹{plan.price}</span>
                            )}
                            <span className="text-xs font-bold text-slate-400">
                              / {selectedFrequency === 'one-time' ? 'meal' : selectedFrequency === 'weekly' ? 'week' : 'month'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 w-full lg:w-auto lg:self-auto">
                        {selectedFrequency !== 'one-time' && (
                          <button
                            type="button"
                            onClick={() => handleCustomizePortions(plan.id)}
                            disabled={isBtnDisabled}
                            className="px-3.5 py-3 rounded-2xl text-xs font-black tracking-wide transition-all border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 active:scale-95 flex items-center gap-1.5 shadow-2xs"
                            title="Customize thali portions before subscribing"
                          >
                            <Sliders className="w-3.5 h-3.5 text-brand" />
                            <span className="hidden sm:inline">Customise Portions</span>
                            <span className="sm:hidden">Customise</span>
                          </button>
                        )}

                        <button
                          onClick={() => handleSubscribe(plan.id)}
                          disabled={isBtnDisabled}
                          className={cn(
                            "px-5 sm:px-6 py-3.5 rounded-2xl text-xs font-black uppercase tracking-wider transition-all shrink-0 active:scale-95 shadow-md",
                            isSubscribed 
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-200 cursor-default shadow-none" 
                              : isSoldOut 
                                ? "bg-rose-50 text-rose-600 border border-rose-200 cursor-not-allowed shadow-none"
                                : "bg-brand hover:bg-amber-600 text-white shadow-brand/20"
                          )}
                        >
                          {subscribing === plan.id ? '...' : isSubscribed ? 'Subscribed' : isSoldOut ? 'Sold Out' : 'Subscribe'}
                        </button>
                      </div>

                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── REVIEWS SECTION ─────────────────────────────────────────── */}
        <div className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-black text-slate-900 tracking-tight">Customer Reviews</h2>
              <p className="text-xs font-semibold text-slate-400">Real feedback from daily eaters</p>
            </div>
            <span className="text-xs font-black text-brand bg-brand/10 px-3 py-1 rounded-full">
              {reviews.length} Reviews
            </span>
          </div>

          {/* User Review Block */}
          <div className="bg-white rounded-3xl p-5 sm:p-6 border border-slate-200/80 shadow-[0_4px_24px_rgba(15,23,42,0.03)] space-y-4">
            {!user ? (
              <div className="text-center py-4">
                <p className="text-sm font-bold text-slate-800 mb-1">Eaten from this kitchen?</p>
                <p className="text-xs text-slate-400 mb-4 font-medium">Sign in to leave your feedback and rating</p>
                <Link href="/login" className="px-6 py-3 bg-brand hover:bg-amber-600 text-white text-xs font-black uppercase tracking-wider rounded-2xl inline-block shadow-md shadow-brand/20">
                  Sign In to Review
                </Link>
              </div>
            ) : myReview && !editingReview ? (
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h4 className="font-black text-slate-900 text-base">Your Feedback</h4>
                    <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[9px] font-black uppercase tracking-wider">Verified Eater</span>
                  </div>
                  <div className="flex gap-0.5 my-1">
                    {[1, 2, 3, 4, 5].map(s => (
                      <Star key={s} className={`w-4 h-4 ${s <= myReview.rating ? 'fill-amber-400 text-amber-500' : 'text-slate-200'}`} />
                    ))}
                  </div>
                  <p className="text-sm text-slate-700 font-medium leading-relaxed italic mt-1">&ldquo;{myReview.review_text}&rdquo;</p>
                </div>
                <button 
                  className="px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200 text-xs font-bold text-slate-600 hover:text-slate-900" 
                  onClick={() => setEditingReview(true)}
                >
                  Edit
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
                  <div>
                    <h4 className="font-black text-slate-900 text-base">{myReview ? 'Update Your Review' : 'How was the food?'}</h4>
                    <p className="text-xs text-slate-400 font-medium mt-0.5">Rate your kitchen experience</p>
                  </div>
                  <StarSelector value={rating} onChange={setRating} />
                </div>

                <textarea
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm font-medium text-slate-800 outline-none focus:bg-white focus:border-brand focus:ring-4 focus:ring-brand/10 transition-all resize-none min-h-[100px] placeholder:text-slate-400"
                  placeholder="Share what you loved about the taste, packaging, hygiene, or on-time delivery..."
                  value={reviewText}
                  onChange={(e) => setReviewText(e.target.value)}
                />

                <div className="flex gap-3 pt-1">
                  <button 
                    className="flex-1 py-3.5 rounded-2xl bg-brand hover:bg-amber-600 text-white font-black text-xs uppercase tracking-wider shadow-md shadow-brand/20 transition-all active:scale-[0.98] disabled:opacity-50" 
                    onClick={handleReviewSubmit} 
                    disabled={submittingReview || rating === 0}
                  >
                    {submittingReview ? 'Posting…' : myReview ? 'Save Updated Review' : 'Post Review'}
                  </button>
                  {myReview && (
                    <button 
                      className="px-5 py-3.5 rounded-2xl bg-slate-100 text-slate-600 font-bold text-xs hover:bg-slate-200" 
                      onClick={() => setEditingReview(false)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Community Reviews */}
          {othersReviews.length === 0 ? (
            <div className="text-center py-8 bg-white rounded-3xl border border-slate-200/80 p-6">
              <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-2 text-slate-300">
                <MessageSquare className="w-6 h-6" />
              </div>
              <p className="text-xs font-bold text-slate-400">No other community reviews yet. Be the first to share your experience!</p>
            </div>
          ) : (
            <div className="space-y-3">
              {othersReviews.map((r) => (
                <div key={r.id} className="bg-white rounded-3xl p-5 border border-slate-200/80 shadow-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-500 to-brand text-white font-black text-xs flex items-center justify-center shadow-xs">
                        {r.user_name?.[0]?.toUpperCase() || 'U'}
                      </div>
                      <div>
                        <h4 className="font-bold text-slate-900 text-sm leading-none">{r.user_name || 'Customer'}</h4>
                        <span className="text-[10px] text-slate-400 font-medium">{formatDate(r.created_at)}</span>
                      </div>
                    </div>

                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4, 5].map(s => (
                        <Star key={s} className={`w-3.5 h-3.5 ${s <= r.rating ? 'fill-amber-400 text-amber-500' : 'text-slate-200'}`} />
                      ))}
                    </div>
                  </div>

                  {r.review_text && (
                    <p className="text-xs text-slate-600 font-medium leading-relaxed pl-10">
                      &ldquo;{r.review_text}&rdquo;
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* Subscription Onboarding Modal */}
      {isModalOpen && vendor && (
        <SubscriptionOnboardingModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          vendor={vendor}
          initialPlanId={modalInitialPlanId}
          initialStep={modalInitialStep}
          category={selectedCategory}
          selectedFrequency={selectedFrequency}
          appliedDiscount={appliedDiscount}
          onSuccess={() => {
            setIsModalOpen(false);
            loadAll();
          }}
        />
      )}

      {/* Downgrade/Combo Alert Modal */}
      {showDowngradeModal && (
        <ConfirmDialog
          isOpen={showDowngradeModal}
          title="Active Combo Plan"
          message="You already have an active Combo (Lunch + Dinner) plan with this kitchen. You don't need an individual meal plan."
          confirmLabel="Got It"
          variant="primary"
          onConfirm={() => setShowDowngradeModal(false)}
          onCancel={() => setShowDowngradeModal(false)}
        />
      )}
    </div>
  );
}
