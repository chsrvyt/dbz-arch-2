'use client';

import { getCurrentPosition, GeolocationError, geoErrorMessage } from '@dabzzo/shared-lib/geolocation';
import { useState, useEffect } from 'react';
import { Loader2, MapPin, Navigation, ArrowLeft, ShieldCheck, CreditCard, Plus, Check, Sparkles, BadgePercent, X } from 'lucide-react';
import { VegIcon, NonVegIcon } from '@/components/shared/DietaryIcon';
import { AppUser, SubscriptionFrequency, MealType, DietaryCategory, SelectedAddon } from '@/types';
import { updateUser } from '@/lib/queries/users';
import { createSubscription } from '@/lib/queries/subscriptions';
import { validateReferralCoupon } from '@/lib/queries/referrals';
import { useUiStore } from '@/store/uiStore';
import { useAuthStore } from '@/store/authStore';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { db } from '@/lib/firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { createRazorpayOrder, verifyPaymentSignature, loadRazorpayCheckoutScript } from '@/lib/razorpay';
import { reverseGeocode } from '@/lib/geo';
import { ThaliCustomizer, ThaliCustomizerConfig } from './ThaliCustomizer';
import { isSubscriptionActive } from '@dabzzo/shared-lib/subscriptionEntitlement';

type RazorpayPaymentResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

interface SubscriptionOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  vendor: AppUser;
  initialPlanId: string;
  initialStep?: number;
  category?: DietaryCategory;
  selectedFrequency: SubscriptionFrequency;
  appliedDiscount: { code: string; discount_pct: number } | null;
  onSuccess: () => void;
}

export function SubscriptionOnboardingModal({
  isOpen,
  onClose,
  vendor,
  initialPlanId,
  initialStep = 1,
  category: initialCategory = 'veg',
  selectedFrequency,
  appliedDiscount,
  onSuccess
}: SubscriptionOnboardingModalProps) {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const addToast = useUiStore((s) => s.addToast);

  const [step, setStep] = useState(initialStep);
  const [address, setAddress] = useState(user?.address || '');
  const [flatBuilding, setFlatBuilding] = useState('');
  const [areaStreet, setAreaStreet] = useState('');
  const [landmark, setLandmark] = useState('');
  const [cityPincode, setCityPincode] = useState('');
  const [location, setLocation] = useState(user?.location || null);
  const [detectingLoc, setDetectingLoc] = useState(false);
  const [planId, setPlanId] = useState(initialPlanId || 'lunch');
  const [dietaryCategory, setDietaryCategory] = useState<DietaryCategory>(initialCategory);
  const [selectedAddonIds, setSelectedAddonIds] = useState<string[]>([]);
  const [customMealConfig, setCustomMealConfig] = useState<ThaliCustomizerConfig | null>(null);
  const [deliveryPreference, setDeliveryPreference] = useState<'8am' | '11am' | null>(user?.deliveryPreference || null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<'idle' | 'creating_order' | 'awaiting_payment' | 'verifying' | 'activating' | 'done'>('idle');
  const [mounted, setMounted] = useState(false);
  const [activeSub, setActiveSub] = useState<any>(null);
  // ── Referral coupon state ──────────────────────────────────────────────
  const [referralCoupon, setReferralCoupon] = useState<{ code: string; discountPct: number } | null>(null);
  const [couponInput, setCouponInput] = useState('');
  const [couponChecking, setCouponChecking] = useState(false);
  const [orderAmountPaise, setOrderAmountPaise] = useState<number | null>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setStep(initialStep || 1);
      setPlanId(initialPlanId || 'lunch');
      setDietaryCategory(initialCategory || 'veg');
      setSelectedAddonIds([]);
      setCustomMealConfig(null);
      setAddress(user?.address || '');
      setLocation(user?.location || null);
      setDeliveryPreference(user?.deliveryPreference || null);
      setPaymentStatus('idle');

      if (user?.address) {
        const parts = user.address.split(',').map((s: string) => s.trim()).filter(Boolean);
        if (parts.length === 1) {
          setFlatBuilding(parts[0]);
        } else if (parts.length === 2) {
          setFlatBuilding(parts[0]);
          setCityPincode(parts[1]);
        } else {
          setFlatBuilding(parts[0]);
          setAreaStreet(parts.slice(1, -1).join(', '));
          setCityPincode(parts[parts.length - 1]);
        }
      }
    }
  }, [isOpen, initialPlanId, initialCategory, user]);

  useEffect(() => {
    if (isOpen && user && vendor.id) {
      const fetchActiveSub = async () => {
        try {
          const subsSnap = await getDocs(query(
            collection(db, 'subscriptions'),
            where('user_id', '==', user.id),
            where('vendor_id', '==', vendor.id),
            where('status', '==', 'active')
          ));
          const nowMs = Date.now();
          if (!subsSnap.empty) {
            const active = subsSnap.docs
              .map(d => ({ id: d.id, ...d.data() } as any))
              .filter((s: any) => isSubscriptionActive(s, nowMs)) // expired cannot earn proration
              .find(s => s.meal_type === 'lunch' || s.meal_type === 'dinner');
            setActiveSub(active || null);
          } else {
            setActiveSub(null);
          }
        } catch (err) {
          console.warn('[OnboardingModal] Failed to fetch active sub:', err);
        }
      };
      fetchActiveSub();
    }
  }, [isOpen, user, vendor.id]);

  if (!mounted || !user) return null;

  // Add-ons list
  const activeVendorAddons = (vendor.addons || []).filter(a => a.active);

  // Helper for Add-On price by subscription frequency
  const getAddonPriceForFrequency = (addon: typeof activeVendorAddons[0]): number => {
    if (selectedFrequency === 'monthly') return addon.monthly_price;
    if (selectedFrequency === 'weekly') return addon.weekly_price || Math.round(addon.monthly_price / 4);
    return addon.onetime_price || Math.round(addon.monthly_price / 30);
  };

  const totalAddonsPrice = selectedAddonIds.reduce((sum, id) => {
    const found = activeVendorAddons.find(a => a.id === id);
    return sum + (found ? getAddonPriceForFrequency(found) : 0);
  }, 0);

  // Plan price calculation based on dietaryCategory
  const isNonVeg = dietaryCategory === 'non_veg';
  const getBasePlanPrice = (pId: string): number => {
    if (selectedFrequency === 'one-time') {
      return isNonVeg ? (vendor.rate_nonveg_onetime || 0) : (vendor.rate_veg_onetime ?? vendor.rate_onetime ?? 0);
    }
    if (pId === 'lunch') {
      return selectedFrequency === 'monthly'
        ? (isNonVeg ? (vendor.rate_nonveg_lunch_monthly || 0) : (vendor.rate_veg_lunch_monthly ?? vendor.rate_lunch_monthly ?? vendor.rate_lunch ?? 0))
        : (isNonVeg ? (vendor.rate_nonveg_lunch_weekly || 0) : (vendor.rate_veg_lunch_weekly ?? vendor.rate_lunch_weekly ?? vendor.rate_lunch ?? 0));
    }
    if (pId === 'dinner') {
      return selectedFrequency === 'monthly'
        ? (isNonVeg ? (vendor.rate_nonveg_dinner_monthly || 0) : (vendor.rate_veg_dinner_monthly ?? vendor.rate_dinner_monthly ?? vendor.rate_dinner ?? 0))
        : (isNonVeg ? (vendor.rate_nonveg_dinner_weekly || 0) : (vendor.rate_veg_dinner_weekly ?? vendor.rate_dinner_weekly ?? vendor.rate_dinner ?? 0));
    }
    if (pId === 'both') {
      return selectedFrequency === 'monthly'
        ? (isNonVeg ? (vendor.rate_nonveg_both_monthly || 0) : (vendor.rate_veg_both_monthly ?? vendor.rate_both_monthly ?? vendor.rate_both ?? 0))
        : (isNonVeg ? (vendor.rate_nonveg_both_weekly || 0) : (vendor.rate_veg_both_weekly ?? vendor.rate_both_weekly ?? vendor.rate_both ?? 0));
    }
    return 0;
  };

  // Proration calculation
  const getProrationCredit = (): { credit: number; activeSubMeal?: string } => {
    if (planId !== 'both' || !activeSub) return { credit: 0 };
    let nextBilling = activeSub.next_billing_date?.toDate ? activeSub.next_billing_date.toDate() : null;
    if (!nextBilling && activeSub.created_at?.toDate) {
      const created = activeSub.created_at.toDate();
      const addDays = activeSub.frequency === 'monthly' ? 30 : activeSub.frequency === 'weekly' ? 7 : 1;
      nextBilling = new Date(created.getTime());
      nextBilling.setDate(nextBilling.getDate() + addDays);
    }
    if (!nextBilling) return { credit: 0 };

    const now = new Date();
    const daysLeft = Math.max(0, Math.ceil((nextBilling.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    if (daysLeft <= 0) return { credit: 0 };

    const totalDays = activeSub.frequency === 'monthly' ? 30 : activeSub.frequency === 'weekly' ? 7 : 1;
    const paidPrice = activeSub.price ?? activeSub.paid_amount ?? 0;
    const credit = Math.round((paidPrice / totalDays) * daysLeft);

    return { credit, activeSubMeal: activeSub.meal_type };
  };

  const { credit: prorationCredit, activeSubMeal } = getProrationCredit();
  const basePrice = getBasePlanPrice(planId);
  const mealsCount = selectedFrequency === 'monthly' ? (planId === 'both' ? 60 : 30) : selectedFrequency === 'weekly' ? (planId === 'both' ? 14 : 7) : (planId === 'both' ? 2 : 1);
  const thaliDeltaTotal = (customMealConfig?.customerDeltaPerMeal || 0) * mealsCount;
  const discountAmt = appliedDiscount ? Math.round((basePrice * appliedDiscount.discount_pct) / 100) : 0;
  const finalPrice = Math.max(0, basePrice + totalAddonsPrice + thaliDeltaTotal - discountAmt - prorationCredit);
  const amountPaise = finalPrice * 100;
  // Referral coupon discount is applied on top (server-computed at order time;
  // this is the client's display estimate, using the same formula).
  const couponDiscountPaise = Math.round((amountPaise * (referralCoupon?.discountPct || 0)) / 100);
  const finalPriceWithCoupon = Math.max(0, finalPrice - Math.round(couponDiscountPaise / 100));
  const payAmountPaise = referralCoupon ? (orderAmountPaise ?? (amountPaise - couponDiscountPaise)) : amountPaise;

  const handleToggleAddon = (id: string) => {
    setSelectedAddonIds(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  const handleDetectLocation = async () => {
    setDetectingLoc(true);
    try {
      // Native-aware: requests the Android runtime permission through the
      // Capacitor plugin, which the raw navigator.geolocation path skipped.
      const { lat, lng } = await getCurrentPosition();
      setLocation({ lat, lng, updated_at: Date.now() });

      {
        try {
          const geo = await reverseGeocode(lat, lng);
          
          const areaParts = [
            geo.building,
            geo.road,
            geo.neighbourhood,
            geo.suburb,
            geo.locality
          ].filter(Boolean);

          const uniqueArea: string[] = [];
          areaParts.forEach((p) => {
            if (p && !uniqueArea.some((u) => u.toLowerCase() === p.toLowerCase())) {
              uniqueArea.push(p);
            }
          });

          if (uniqueArea.length > 0) {
            setAreaStreet(uniqueArea.join(', '));
          }

          const cityParts = [geo.city, geo.state, geo.pincode ? `PIN ${geo.pincode}` : ''].filter(Boolean);
          if (cityParts.length > 0) {
            setCityPincode(cityParts.join(', '));
          }

          if (geo.completeAddress) {
            setAddress(geo.completeAddress);
          }
          addToast('GPS location & area detected! 📍', 'success');
        } catch (e) {
          addToast('Location coordinates captured!', 'success');
        } finally {
          setDetectingLoc(false);
        }
      }
    } catch (err: unknown) {
      setDetectingLoc(false);
      // Say WHICH failure it was; the old handler blamed permissions for
      // timeouts and no-fix alike, sending people to the wrong setting.
      const reason = err instanceof GeolocationError ? err.reason : 'unknown';
      addToast(geoErrorMessage(reason), 'error');
    }
  };

  const handleConfirmStep1 = () => {
    const computed = [
      flatBuilding.trim(),
      landmark.trim() ? `(Landmark: ${landmark.trim()})` : '',
      areaStreet.trim(),
      cityPincode.trim()
    ].filter(Boolean).join(', ') || address.trim();

    if (!computed.trim()) {
      addToast('Please enter your delivery doorstep address', 'error');
      return;
    }
    setAddress(computed);
    setStep(2);
  };
  const handleConfirmStep2 = () => setStep(3);
  const handleConfirmStep3 = () => setStep(4);
  const handleConfirmStep4 = () => {
    if (!deliveryPreference) { addToast('Please select a delivery slot', 'error'); return; }
    setStep(5);
  };

  const handleApplyCoupon = async () => {
    const code = couponInput.trim().toUpperCase();
    if (!code) { addToast('Enter a coupon code first', 'warning'); return; }
    setCouponChecking(true);
    try {
      const res = await validateReferralCoupon(code);
      if (res.valid && res.discountPct) {
        setReferralCoupon({ code: res.code, discountPct: res.discountPct });
        setCouponInput('');
        addToast(`${res.discountPct}% OFF referral coupon applied! 🎉`, 'success');
      } else {
        addToast(res.message || 'This coupon is invalid or not usable here.', 'error');
      }
    } catch {
      addToast('Could not validate coupon. Try again.', 'error');
    } finally {
      setCouponChecking(false);
    }
  };

  const handleRemoveCoupon = () => {
    setReferralCoupon(null);
    setOrderAmountPaise(null);
  };

  const activateVerifiedSubscription = async (response: RazorpayPaymentResponse) => {
    setPaymentStatus('activating');
    const userUpdates: Partial<AppUser> = {
      address,
      location: location || undefined,
      deliveryPreference: deliveryPreference || undefined,
    };
    await updateUser(user.id, userUpdates);
    setUser({ ...user, ...userUpdates });

    const structuredAddons: SelectedAddon[] = selectedAddonIds.map(id => {
      const a = activeVendorAddons.find(item => item.id === id)!;
      return {
        id: a.id,
        name: a.name,
        monthly_price: a.monthly_price,
        weekly_price: a.weekly_price,
        onetime_price: a.onetime_price,
        price_paid: getAddonPriceForFrequency(a),
      };
    });

    await createSubscription({
      user_id: user.id,
      vendor_id: vendor.id,
      vendor_name: vendor.kitchen_name || vendor.name,
      plan_id: planId,
      meal_type: planId as MealType,
      category: dietaryCategory,
      frequency: selectedFrequency,
      total_meals: mealsCount,
      selected_addons: structuredAddons,
      base_price: basePrice,
      addons_price: totalAddonsPrice,
      total_price: basePrice + totalAddonsPrice + thaliDeltaTotal,
      discount_pct: referralCoupon ? referralCoupon.discountPct : appliedDiscount?.discount_pct,
      promo_code: referralCoupon ? referralCoupon.code : appliedDiscount?.code,
      payment_id: response.razorpay_payment_id,
      razorpay_order_id: response.razorpay_order_id,
      paid_amount: referralCoupon ? Math.round(payAmountPaise / 100) : finalPrice,
      custom_meal_config: customMealConfig || undefined,
      meal_components: customMealConfig?.manifestSummary ? [customMealConfig.manifestSummary] : undefined,
    });

    setPaymentStatus('done');
    addToast('Subscription activated! 🍛', 'success');
    onSuccess();
    onClose();
  };

  const verifyPayment = async (response: RazorpayPaymentResponse) => {
    setPaymentStatus('verifying');
    await verifyPaymentSignature(
      response.razorpay_payment_id,
      response.razorpay_order_id,
      response.razorpay_signature
    );
  };

  const handleConfirmPay = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    try {
      if (finalPrice === 0) {
        setPaymentStatus('activating');
        /* eslint-disable react-hooks/purity -- runs inside the handleConfirmPay
           click handler, not during render; these are one-off synthetic ids for
           a zero-value (free) upgrade that never reaches Razorpay. */
        const mockResponse = {
          razorpay_payment_id: 'upg_free_' + Math.random().toString(36).slice(2, 9),
          razorpay_order_id: 'upg_free_' + Math.random().toString(36).slice(2, 9),
          razorpay_signature: 'free'
        };
        /* eslint-enable react-hooks/purity */
        await activateVerifiedSubscription(mockResponse);
        return;
      }

      setPaymentStatus('creating_order');
      await loadRazorpayCheckoutScript();

      const order = await createRazorpayOrder(
        amountPaise,
        `sub_${user.id}_${vendor.id}_${planId}`.slice(0, 40),
        {
          user_id: user.id,
          vendor_id: vendor.id,
          plan_id: planId,
          frequency: selectedFrequency,
          category: dietaryCategory,
        },
        vendor.id,
        referralCoupon ? { coupon: referralCoupon.code, base_amount_paise: amountPaise } : undefined
      );

      const order_id = order.order_id;
      // When a referral coupon applies, the server returns the authoritative
      // discounted amount — use it for the checkout & the recorded paid_amount.
      if (referralCoupon && order.amount) {
        setOrderAmountPaise(order.amount);
      }
      setPaymentStatus('awaiting_payment');
      const chargedPaise = referralCoupon && order.amount ? order.amount : amountPaise;

      const paymentResponse = await new Promise<RazorpayPaymentResponse>((resolve, reject) => {
        const RazorpayConstructor = window.Razorpay;
        if (!RazorpayConstructor) {
          reject(new Error('Razorpay SDK failed to load. Please check your internet connection.'));
          return;
        }

        const rzp = new RazorpayConstructor({
          key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_live_TarSzNR6D7TlJJ',
          amount: chargedPaise,
          currency: 'INR',
          name: vendor.kitchen_name || vendor.name || 'Dabzzo',
          description: `${dietaryCategory === 'non_veg' ? '🍗 Non-Veg ' : '🌿 Veg '}${planId.charAt(0).toUpperCase() + planId.slice(1)} Plan — ${selectedFrequency}`,
          image: vendor.image || undefined,
          order_id,
          prefill: {
            name: user.name || '',
            contact: user.phone || '',
            email: user.email || '',
          },
          theme: { color: '#f97316' },
          modal: {
            ondismiss: () => {
              reject(new Error('dismissed'));
            },
          },
          handler: (resp: RazorpayPaymentResponse) => {
            resolve(resp);
          },
        });

        rzp.on('payment.failed', (resp: { error?: { description?: string } }) => {
          reject(new Error(resp.error?.description || 'Payment failed.'));
        });

        rzp.open();
      });

      await verifyPayment(paymentResponse);
      await activateVerifiedSubscription(paymentResponse);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Payment failed. Please try again.';
      if (message !== 'dismissed') {
        addToast(message, 'error');
      }
      setPaymentStatus('idle');
    } finally {
      setIsSubmitting(false);
    }
  };

  const payButtonLabel = () => {
    switch (paymentStatus) {
      case 'creating_order':  return 'Creating Order…';
      case 'awaiting_payment': return 'Opening Payment…';
      case 'verifying':       return 'Verifying Payment…';
      case 'activating':      return 'Activating Plan…';
      default: return `Pay ₹${referralCoupon ? finalPriceWithCoupon : finalPrice} with Razorpay`;
    }
  };

  const hasVeg = !vendor.dietary_categories || vendor.dietary_categories.includes('veg');
  const hasNonVeg = vendor.dietary_categories?.includes('non_veg');
  const hasBoth = hasVeg && hasNonVeg;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[100] bg-slate-950/40 backdrop-blur-sm"
          />

          <div className="fixed inset-0 z-[101] flex items-end sm:items-center justify-center p-0 sm:p-4 pointer-events-none">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ type: 'spring', damping: 25, stiffness: 240 }}
              className="pointer-events-auto w-full sm:w-[480px] max-h-[92dvh] sm:max-h-[86vh] bg-white rounded-t-[2.5rem] sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-slate-100"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-100 bg-white shrink-0">
                <div className="flex items-center gap-3">
                  {step > 1 && !isSubmitting && (
                    <button onClick={() => setStep(step - 1)} className="p-2 -ml-2 rounded-full hover:bg-slate-100 transition-colors">
                      <ArrowLeft className="w-5 h-5 text-slate-600" />
                    </button>
                  )}
                  <div>
                    <h2 className="text-lg font-black text-slate-900 leading-tight">
                      {step === 1 ? 'Delivery Location' : step === 2 ? 'Select Plan & Category' : step === 3 ? 'Add-Ons & Extras' : step === 4 ? 'Delivery Slot' : 'Confirm & Pay'}
                    </h2>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Step {step} of 5</p>
                  </div>
                </div>
                {!isSubmitting && (
                  <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 transition-colors text-slate-500 font-bold">
                    ✕
                  </button>
                )}
              </div>

              {/* Content */}
              <div className="p-4 sm:p-6 overflow-y-auto flex-1 min-h-0 bg-white">

                {/* ── Step 1: Location ─────────────────────────────────────── */}
                {step === 1 && (
                  <div className="space-y-4 animate-fade-in">
                    {/* Live GPS Header Card */}
                    <div className="bg-slate-50/80 border border-slate-200/80 rounded-2xl p-4 flex items-center justify-between gap-3 shadow-xs">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                          location ? 'bg-emerald-100 text-emerald-700' : 'bg-brand/10 text-brand'
                        }`}>
                          <Navigation className={`w-5 h-5 ${detectingLoc ? 'animate-spin' : ''}`} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-black text-slate-900 leading-tight">
                            {location ? 'GPS Location Pinned' : 'Delivery Coordinates'}
                          </p>
                          <p className="text-[11px] text-slate-400 font-medium truncate mt-0.5">
                            {detectingLoc 
                              ? 'Locating high-precision GPS...' 
                              : cityPincode || (location ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : 'Tap to pin current location')}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={handleDetectLocation}
                        disabled={detectingLoc}
                        className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-black uppercase tracking-wider transition-all shrink-0 active:scale-95 shadow-xs"
                      >
                        {detectingLoc ? 'Locating…' : location ? 'Re-Pin GPS' : 'Use GPS'}
                      </button>
                    </div>

                    {/* Form Fields for Maximum Rider Accuracy */}
                    <div className="space-y-3">
                      <div>
                        <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                          Flat / House / Floor No. & Building <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={flatBuilding}
                          onChange={(e) => setFlatBuilding(e.target.value)}
                          placeholder="e.g. Flat 402, Sunshine Heights, Wing B"
                          className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-3 text-sm font-medium text-slate-900 outline-none focus:border-brand focus:ring-2 focus:ring-brand/10 transition-all shadow-xs"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                          Area / Street / Colony <span className="text-slate-400 font-normal">(Auto-Detected)</span>
                        </label>
                        <input
                          type="text"
                          value={areaStreet}
                          onChange={(e) => setAreaStreet(e.target.value)}
                          placeholder="e.g. Near Medical Square, Rambagh"
                          className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-3 text-sm font-medium text-slate-900 outline-none focus:border-brand focus:ring-2 focus:ring-brand/10 transition-all shadow-xs"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                            Landmark <span className="text-slate-400 font-normal">(Optional)</span>
                          </label>
                          <input
                            type="text"
                            value={landmark}
                            onChange={(e) => setLandmark(e.target.value)}
                            placeholder="e.g. Opp. SBI Bank"
                            className="w-full bg-white border border-slate-200 rounded-xl px-3.5 py-3 text-sm font-medium text-slate-900 outline-none focus:border-brand focus:ring-2 focus:ring-brand/10 transition-all shadow-xs"
                          />
                        </div>

                        <div>
                          <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                            City & Pincode
                          </label>
                          <input
                            type="text"
                            value={cityPincode}
                            onChange={(e) => setCityPincode(e.target.value)}
                            placeholder="e.g. Nagpur, Maharashtra - 440008"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-3 text-sm font-medium text-slate-900 outline-none focus:border-brand focus:ring-2 focus:ring-brand/10 transition-all shadow-xs"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Step 2: Plan & Category ──────────────────────────────── */}
                {step === 2 && (
                  <div className="space-y-5 animate-fade-in">
                    {/* Dietary Category Selector */}
                    {hasBoth && (
                      <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-2xl">
                        <button
                          type="button"
                          onClick={() => setDietaryCategory('veg')}
                          className={`py-2.5 px-3 rounded-xl text-xs font-black flex items-center justify-center gap-2 transition-all ${
                            dietaryCategory === 'veg'
                              ? 'bg-white text-emerald-700 shadow-sm'
                              : 'text-slate-500 hover:text-slate-800'
                          }`}
                        >
                          <VegIcon size={16} /> Pure Veg
                        </button>
                        <button
                          type="button"
                          onClick={() => setDietaryCategory('non_veg')}
                          className={`py-2.5 px-3 rounded-xl text-xs font-black flex items-center justify-center gap-2 transition-all ${
                            dietaryCategory === 'non_veg'
                              ? 'bg-white text-rose-700 shadow-sm'
                              : 'text-slate-500 hover:text-slate-800'
                          }`}
                        >
                          <NonVegIcon size={16} /> Non-Veg
                        </button>
                      </div>
                    )}

                    <div className="space-y-3">
                      {(['lunch', 'dinner', 'both'] as const).map((type) => {
                        const p = getBasePlanPrice(type);
                        if (!p) return null;
                        return (
                          <label
                            key={type}
                            className={`block relative p-4 rounded-2xl border-2 transition-all cursor-pointer ${
                              planId === type ? 'border-brand bg-brand-50/20' : 'border-slate-100 hover:border-slate-200'
                            }`}
                          >
                            <input type="radio" name="plan" value={type} checked={planId === type} onChange={() => setPlanId(type)} className="hidden" />
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${planId === type ? 'border-brand' : 'border-slate-300'}`}>
                                  {planId === type && <div className="w-2.5 h-2.5 bg-brand rounded-full" />}
                                </div>
                                <div>
                                  <span className="font-bold text-slate-900 block leading-tight capitalize">
                                    {type === 'both' ? 'Lunch + Dinner' : `${type.charAt(0).toUpperCase() + type.slice(1)} Plan`}
                                  </span>
                                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                    {dietaryCategory === 'non_veg' ? '🍗 Non-Vegetarian' : '🌿 Pure Veg'}
                                  </span>
                                </div>
                              </div>
                              <span className="font-black text-slate-900 text-sm">
                                ₹{p}<span className="text-[10px] font-bold text-slate-400">/{selectedFrequency === 'monthly' ? 'mo' : selectedFrequency === 'weekly' ? 'wk' : 'meal'}</span>
                              </span>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ── Step 3: Add-Ons & Extras ─────────────────────────────── */}
                {step === 3 && (
                  <div className="space-y-5 animate-fade-in">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Sparkles className="w-4 h-4 text-amber-500" />
                        <h3 className="text-sm font-black text-slate-900">Customise Your Tiffin with Add-Ons & Portions</h3>
                      </div>
                      <p className="text-xs text-slate-500 font-medium leading-relaxed">
                        Adjust your daily thali portions (extra rotis, rice, dal) and select recurring sweets or sides.
                      </p>
                    </div>

                    {/* Thali Portions Customizer */}
                    <div className="rounded-2xl border border-amber-200/80 bg-amber-50/20 p-3.5">
                      <ThaliCustomizer
                        baseMealPrice={Math.round((basePrice / Math.max(1, mealsCount)) * 100) / 100}
                        planType={selectedFrequency === 'monthly' ? 'monthly' : selectedFrequency === 'weekly' ? 'weekly' : 'daily'}
                        vendorOverrides={vendor.custom_component_rates}
                        vendorMarginOverride={vendor.vendor_margin_percent ?? vendor.vendor_margin_override}
                        onChange={(config) => setCustomMealConfig(config)}
                        compact
                        title="Customize Daily Thali Portions"
                      />
                    </div>

                    <div>
                      <h4 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-2">Kitchen Extras & Add-Ons</h4>
                    </div>

                    {activeVendorAddons.length === 0 ? (
                      <div className="bg-slate-50 rounded-2xl p-6 text-center border border-slate-100">
                        <p className="text-xs font-bold text-slate-400">No add-ons available for this kitchen right now.</p>
                      </div>
                    ) : (
                      <div className="space-y-2.5 max-h-[260px] overflow-y-auto pr-1">
                        {activeVendorAddons.map((addon) => {
                          const isSelected = selectedAddonIds.includes(addon.id);
                          const addonPrice = getAddonPriceForFrequency(addon);

                          return (
                            <div
                              key={addon.id}
                              onClick={() => handleToggleAddon(addon.id)}
                              className={`p-3.5 rounded-2xl border-2 transition-all cursor-pointer flex items-center justify-between ${
                                isSelected ? 'border-amber-500 bg-amber-50/30' : 'border-slate-100 hover:border-slate-200'
                              }`}
                            >
                              <div className="flex items-center gap-3">
                                <div className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center transition-colors ${
                                  isSelected ? 'bg-amber-500 border-amber-500 text-white' : 'border-slate-300 bg-white'
                                }`}>
                                  {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                                </div>
                                <div>
                                  <p className="text-xs font-black text-slate-900 leading-tight">{addon.name}</p>
                                  {addon.description && (
                                    <p className="text-[10px] text-slate-400 mt-0.5">{addon.description}</p>
                                  )}
                                </div>
                              </div>

                              <span className="text-xs font-black text-amber-800">
                                +₹{addonPrice}
                                <span className="text-[9px] font-bold text-slate-400">
                                  /{selectedFrequency === 'monthly' ? 'mo' : selectedFrequency === 'weekly' ? 'wk' : 'meal'}
                                </span>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Step 4: Delivery Slot ─────────────────────────────────── */}
                {step === 4 && (
                  <div className="space-y-6 animate-fade-in">
                    <p className="text-sm text-slate-600 font-medium leading-relaxed">
                      Choose a convenient delivery window for your meal orders.
                    </p>

                    <div className="flex gap-3">
                      {(['8am', '11am'] as const).map((slot) => (
                        <button
                          key={slot}
                          type="button"
                          onClick={() => setDeliveryPreference(slot)}
                          className={`flex-1 py-4 rounded-2xl border-2 transition-all font-bold text-sm ${
                            deliveryPreference === slot ? 'border-brand bg-brand-50 text-brand' : 'border-slate-100 text-slate-500 hover:border-slate-200'
                          }`}
                        >
                          {slot === '8am' ? '8:00 AM' : '11:00 AM'}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Step 5: Order Summary + Razorpay Pay Button ──────────── */}
                {step === 5 && (
                  <div className="space-y-5 animate-fade-in">
                    {/* Referral coupon block */}
                    {referralCoupon ? (
                      <div className="flex items-center justify-between bg-amber-50/80 border border-amber-200/70 rounded-2xl px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <BadgePercent className="w-4 h-4 text-amber-700 shrink-0" />
                          <div>
                            <p className="text-xs font-black text-amber-900">
                              Referral coupon applied — {referralCoupon.discountPct}% OFF
                            </p>
                            <p className="text-[10px] font-bold text-amber-700">
                              {referralCoupon.code} · valid on monthly plans only
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={handleRemoveCoupon}
                          className="w-7 h-7 rounded-full bg-white border border-amber-200 flex items-center justify-center text-amber-700 hover:bg-amber-100 transition-colors cursor-pointer"
                          aria-label="Remove coupon"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <BadgePercent className="w-4 h-4 text-slate-400" />
                          <p className="text-[11px] font-black text-slate-500 uppercase tracking-widest">
                            Have a Referral coupon?
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={couponInput}
                            onChange={(e) => setCouponInput(e.target.value.toUpperCase().slice(0, 12))}
                            placeholder="e.g. REF10-AB12CD"
                            className="flex-1 bg-slate-50 border-2 border-slate-100 rounded-2xl px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-amber-500 focus:bg-white transition-all placeholder:text-slate-400 placeholder:font-normal"
                          />
                          <button
                            type="button"
                            onClick={handleApplyCoupon}
                            disabled={couponChecking || !couponInput.trim()}
                            className="px-4 py-3 bg-slate-950 hover:bg-slate-800 disabled:opacity-40 text-white rounded-2xl text-xs font-black uppercase tracking-widest transition-all cursor-pointer flex items-center gap-1.5"
                          >
                            {couponChecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Apply'}
                          </button>
                        </div>
                        <p className="text-[10px] text-slate-400 font-medium mt-1.5 ml-1">
                          Referral coupons work only on monthly plans.
                        </p>
                      </div>
                    )}

                    {/* Order breakdown */}
                    <div className="bg-slate-50 p-5 rounded-2xl space-y-3">
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 font-medium">Vendor</span>
                        <span className="font-bold text-slate-900">{vendor.kitchen_name || vendor.name}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 font-medium">Plan</span>
                        <span className="font-bold text-slate-900 capitalize">
                          {dietaryCategory === 'non_veg' ? '🍗 Non-Veg ' : '🌿 Veg '}
                          {planId === 'both' ? 'Lunch + Dinner' : `${planId.charAt(0).toUpperCase() + planId.slice(1)} Plan`} ({selectedFrequency})
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 font-medium">Delivery Slot</span>
                        <span className="font-bold text-slate-900">{deliveryPreference === '8am' ? '8:00 AM' : '11:00 AM'}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 font-medium">Address</span>
                        <span className="font-bold text-slate-900 text-right max-w-[60%] truncate">{address}</span>
                      </div>

                      {/* Selected Add-Ons summary */}
                      {selectedAddonIds.length > 0 && (
                        <div className="pt-2 border-t border-slate-200">
                          <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1.5">Selected Add-Ons</span>
                          {selectedAddonIds.map(id => {
                            const a = activeVendorAddons.find(item => item.id === id);
                            if (!a) return null;
                            const price = getAddonPriceForFrequency(a);
                            return (
                              <div key={id} className="flex justify-between text-xs text-slate-700 py-0.5">
                                <span>+ {a.name}</span>
                                <span className="font-bold">₹{price}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <hr className="border-slate-200 my-1" />

                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 font-medium">Base Plan Price</span>
                        <span className="font-bold text-slate-900">₹{basePrice}</span>
                      </div>
                      {customMealConfig && customMealConfig.manifestSummary && (
                        <div className="p-2.5 bg-amber-50/80 rounded-xl border border-amber-200/60 text-xs">
                          <span className="font-bold text-amber-900 block mb-0.5">📦 Customized Thali Portions:</span>
                          <span className="text-amber-800 text-[11px] font-medium leading-tight block">{customMealConfig.manifestSummary}</span>
                        </div>
                      )}
                      {thaliDeltaTotal !== 0 && (
                        <div className="flex justify-between text-sm text-amber-800">
                          <span className="font-medium">Thali Portions Delta ({mealsCount} meals)</span>
                          <span className="font-bold">{thaliDeltaTotal > 0 ? `+₹${thaliDeltaTotal}` : `-₹${Math.abs(thaliDeltaTotal)}`}</span>
                        </div>
                      )}
                      {totalAddonsPrice > 0 && (
                        <div className="flex justify-between text-sm text-amber-800">
                          <span className="font-medium">Add-Ons Total</span>
                          <span className="font-bold">+₹{totalAddonsPrice}</span>
                        </div>
                      )}
                      {appliedDiscount && (
                        <div className="flex justify-between text-sm text-emerald-600">
                          <span className="font-medium">Discount ({appliedDiscount.code}) — {appliedDiscount.discount_pct}%</span>
                          <span className="font-bold">−₹{discountAmt}</span>
                        </div>
                      )}
                      {prorationCredit > 0 && (
                        <div className="flex justify-between text-sm text-brand">
                          <span className="font-medium">Upgrade Credit ({activeSubMeal} remaining)</span>
                          <span className="font-bold">−₹{prorationCredit}</span>
                        </div>
                      )}
                      {referralCoupon && couponDiscountPaise > 0 && (
                        <div className="flex justify-between text-sm text-amber-700">
                          <span className="font-medium">Referral Coupon ({(referralCoupon.discountPct)}%)</span>
                          <span className="font-bold">−₹{Math.round(couponDiscountPaise / 100)}</span>
                        </div>
                      )}
                      <div className="flex justify-between items-center pt-1">
                        <span className="font-bold text-slate-900">Total Payable</span>
                        <span className="text-xl font-black text-brand">₹{referralCoupon ? finalPriceWithCoupon : finalPrice}</span>
                      </div>
                    </div>

                    {/* Trust badge */}
                    <div className="flex items-center gap-2 px-1">
                      <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                      <p className="text-xs text-slate-500 font-medium">Secured by Razorpay — 100% safe & encrypted</p>
                    </div>

                  </div>
                )}
              </div>

              {/* Sticky Footer Action Bar */}
              <div
                className="p-4 sm:px-6 sm:py-4 border-t border-slate-100 bg-white/95 backdrop-blur-xs shrink-0"
                // The sheet is bottom-anchored on phones, so this action row lands
                // exactly where the gesture bar / home indicator sits. Pad by the
                // safe-area inset so Next / Pay is actually tappable. Reads 0 on
                // devices without an inset, and only reports a real value now that
                // viewport-fit=cover is set.
                style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
              >
                {step === 1 && (
                  <button 
                    type="button"
                    onClick={handleConfirmStep1} 
                    className="w-full py-3.5 sm:py-4 bg-slate-950 hover:bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-xs transition-all active:scale-[0.98] shadow-md shadow-slate-950/10 cursor-pointer"
                  >
                    Confirm Delivery Address
                  </button>
                )}

                {step === 2 && (
                  <button 
                    type="button"
                    onClick={handleConfirmStep2} 
                    className="w-full py-3.5 sm:py-4 bg-slate-950 hover:bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-xs transition-transform active:scale-95 shadow-md shadow-slate-950/10 cursor-pointer"
                  >
                    Confirm Plan
                  </button>
                )}

                {step === 3 && (
                  <button 
                    type="button"
                    onClick={handleConfirmStep3} 
                    className="w-full py-3.5 sm:py-4 bg-slate-950 hover:bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-xs transition-transform active:scale-95 shadow-md shadow-slate-950/10 cursor-pointer"
                  >
                    {customMealConfig && customMealConfig.customerDeltaPerMeal > 0
                      ? `Continue with Portions (+₹${customMealConfig.customerDeltaPerMeal}/meal)`
                      : selectedAddonIds.length > 0 
                        ? `Continue with ${selectedAddonIds.length} Add-On${selectedAddonIds.length > 1 ? 's' : ''}` 
                        : 'Continue to Delivery Slot'}
                  </button>
                )}

                {step === 4 && (
                  <button 
                    type="button"
                    onClick={handleConfirmStep4} 
                    className="w-full py-3.5 sm:py-4 bg-slate-950 hover:bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest text-xs transition-transform active:scale-95 shadow-md shadow-slate-950/10 cursor-pointer"
                  >
                    Confirm Slot
                  </button>
                )}

                {step === 5 && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      id="razorpay-subscription-pay-btn"
                      onClick={handleConfirmPay}
                      disabled={isSubmitting}
                      className="w-full py-4 flex items-center justify-center gap-2.5 bg-brand text-white rounded-2xl font-black uppercase tracking-widest text-xs transition-all active:scale-95 shadow-xl shadow-brand/25 disabled:opacity-60 disabled:cursor-not-allowed hover:bg-brand/90 cursor-pointer"
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {payButtonLabel()}
                        </>
                      ) : (
                        <>
                          <CreditCard className="w-4 h-4" />
                          Pay ₹{finalPrice} with Razorpay
                        </>
                      )}
                    </button>

                    <p className="text-center text-[11px] text-slate-400 font-medium">
                      UPI · Cards · Net Banking · Wallets accepted
                    </p>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
