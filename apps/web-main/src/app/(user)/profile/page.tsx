'use client';

import { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useUiStore } from '@/store/uiStore';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { updateUser } from '@/lib/queries/users';
import { uploadImage, getImageUrl } from '@/lib/storage';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Gift, Star, ChevronRight, Calendar, AlertCircle, RefreshCw, Plus, Minus, CreditCard } from 'lucide-react';
import { PaymentModal } from '@/components/shared/PaymentModal';
import { RewardsModal } from '@/components/shared/RewardsModal';
import { redeemCreditsForDays } from '@/lib/queries/swaps';
import type { SubscriptionSwapAllowance } from '@/types';
import { createRazorpayOrder, verifyPaymentSignature, loadRazorpayCheckoutScript } from '@/lib/razorpay';
import { getErrorMessage } from '@dabzzo/shared-lib/errors';
import { isSubscriptionActive, isSubscriptionExpired } from '@dabzzo/shared-lib/subscriptionEntitlement';

export default function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);
  const addToast = useUiStore((s) => s.addToast);
  const router = useRouter();
  
  const [loadingImage, setLoadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [totalCredits, setTotalCredits] = useState(0);
  const [creditHistory, setCreditHistory] = useState<any[]>([]);
  const [activeSubscriptions, setActiveSubscriptions] = useState<any[]>([]);
  const [expiredSubscriptions, setExpiredSubscriptions] = useState<any[]>([]);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [selectedSubForPayment, setSelectedSubForPayment] = useState<any>(null);
  const [redeemingCredits, setRedeemingCredits] = useState(false);
  const [isRewardsModalOpen, setIsRewardsModalOpen] = useState(false);

  // Buy Swaps state
  const [swapAllowances, setSwapAllowances] = useState<Record<string, SubscriptionSwapAllowance>>({});
  const [purchaseQty, setPurchaseQty] = useState<Record<string, number>>({});
  const [buyingSwapId, setBuyingSwapId] = useState<string | null>(null);

  // Name editing states
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(user?.name || '');
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    if (user?.name) {
      setNameInput(user.name);
    }
  }, [user?.name]);

  useEffect(() => {
    if (!user) return;
    
    // Listen to user credits
    const q = query(
      collection(db, 'user_credits'),
      where('user_id', '==', user.id)
    );
    const unsub = onSnapshot(q, (snap) => {
      const credits = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
      const unredeemed = credits.filter(c => !c.redeemed).reduce((sum, c) => sum + (c.credit_amount || 0), 0);
      setTotalCredits(Math.round(unredeemed * 10) / 10);
      setCreditHistory(credits.sort((a, b) => (b.created_at?.seconds ?? 0) - (a.created_at?.seconds ?? 0)).slice(0, 5));
    });

    // Listen to active subscriptions (entitlement-aware: expired-but-stored-
    // active subs move to the "Expired — Renew" group).
    const qSubs = query(
      collection(db, 'subscriptions'),
      where('user_id', '==', user.id),
      where('status', '==', 'active')
    );
    const unsubSubs = onSnapshot(qSubs, (snap) => {
      const nowMs = Date.now();
      const raw = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setExpiredSubscriptions(raw.filter((s: any) => isSubscriptionExpired(s, nowMs)));
      setActiveSubscriptions(raw.filter((s: any) => isSubscriptionActive(s, nowMs)));
    });

    // Listen to swap allowances in real-time
    const qAllowances = query(
      collection(db, 'subscription_swap_allowances'),
      where('user_id', '==', user.id)
    );
    const unsubAllowances = onSnapshot(qAllowances, (snap) => {
      const mapping: Record<string, SubscriptionSwapAllowance> = {};
      snap.docs.forEach(doc => {
        const data = doc.data() as SubscriptionSwapAllowance;
        if (data.subscription_id) {
          mapping[data.subscription_id] = data;
        }
      });
      setSwapAllowances(mapping);
    });

    return () => {
      unsub();
      unsubSubs();
      unsubAllowances();
    };
  }, [user]);

  async function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setLoadingImage(true);
    try {
      const url = await uploadImage(file);
      if (url) {
        await updateUser(user.id, { image: url });
        setUser({ ...user, image: url });
        addToast('Profile image updated! 📸', 'success');
      } else {
        addToast('Upload failed. Check your connection or storage rules.', 'error');
      }
    } catch (err) {
      addToast('Image upload failed', 'error');
    } finally {
      setLoadingImage(false);
    }
  }

  function handleLogout() {
    logout();
    router.replace('/login');
    addToast('Signed out successfully', 'info');
  }

  async function updatePreference(slot: '8am' | '11am') {
    if (!user) return;
    try {
      await updateUser(user.id, { deliveryPreference: slot });
      setUser({ ...user, deliveryPreference: slot });
      addToast(`Lunch delivery preference updated to ${slot === '8am' ? '8:00 AM' : '11:00 AM'}! 🍱`, 'success');
    } catch (err) {
      addToast('Failed to update preference.', 'error');
    }
  }

  async function handleRedeem() {
    if (!user || activeSubscriptions.length === 0) {
      addToast('You need an active subscription to redeem credits.', 'error');
      return;
    }
    
    setRedeemingCredits(true);
    try {
      const days = await redeemCreditsForDays(user.id, activeSubscriptions[0].id);
      addToast(`Successfully redeemed! Added ${days} days to your subscription. 🎉`, 'success');
    } catch (err: unknown) {
      addToast(getErrorMessage(err) || 'Failed to redeem credits.', 'error');
    } finally {
      setRedeemingCredits(false);
    }
  }

  // Handle buy swaps quantity change
  function handleSwapQtyChange(subId: string, diff: number) {
    setPurchaseQty(prev => {
      const current = prev[subId] || 1;
      const next = Math.max(1, Math.min(10, current + diff));
      return { ...prev, [subId]: next };
    });
  }

  // Handle purchase of extra swaps using Razorpay (₹29 per swap)
  async function handleBuySwaps(subId: string) {
    if (buyingSwapId) return;
    setBuyingSwapId(subId);
    const qty = purchaseQty[subId] || 1;
    const amount = qty * 29;

    try {
      await loadRazorpayCheckoutScript();
      
      // 1. Create order (Callable Cloud Function + REST fallback)
      const order = await createRazorpayOrder(
        amount * 100, // paise
        `buyswaps_${subId}_${Date.now()}`.slice(0, 40),
        {
          user_id: user?.id,
          subscription_id: subId,
          qty: String(qty),
          type: 'buy_swaps',
        }
      );

      const order_id = order.order_id;

      // 2. Open Razorpay Checkout modal
      const paymentResponse = await new Promise<any>((resolve, reject) => {
        const RazorpayConstructor = window.Razorpay;
        if (!RazorpayConstructor) {
          reject(new Error('Razorpay SDK failed to load. Please check your internet connection.'));
          return;
        }

        const rzp = new RazorpayConstructor({
          key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_live_TarSzNR6D7TlJJ',
          amount: amount * 100,
          currency: 'INR',
          name: 'Dabzzo',
          description: `Buy ${qty} Extra Meal Swap${qty > 1 ? 's' : ''}`,
          order_id,
          prefill: {
            name: user?.name || '',
            contact: user?.phone || '',
            email: user?.email || '',
          },
          theme: { color: '#f97316' },
          modal: {
            ondismiss: () => reject(new Error('Payment cancelled by user.'))
          },
          handler: (response: any) => resolve(response)
        });

        rzp.on('payment.failed', (resp: any) => {
          reject(new Error(resp.error?.description || 'Payment failed.'));
        });

        rzp.open();
      });

      // 3. Verify Payment
      await verifyPaymentSignature(
        paymentResponse.razorpay_payment_id,
        paymentResponse.razorpay_order_id,
        paymentResponse.razorpay_signature
      );

      // 4. Toast notification (UI will update automatically via real-time listener)
      if (user) {
        addToast(`Successfully bought ${qty} extra swaps! 🎉`, 'success');
        setPurchaseQty(prev => ({ ...prev, [subId]: 1 }));
      }
    } catch (err: unknown) {
      addToast(getErrorMessage(err) || 'Swap purchase failed', 'error');
    } finally {
      setBuyingSwapId(null);
    }
  }

  function formatPhone(p?: string) {
    if (!p) return '—';
    const digits = p.replace(/\D/g, '').slice(-10);
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }

  async function handleSaveName() {
    if (!user || !nameInput.trim()) return;
    setSavingName(true);
    try {
      await updateUser(user.id, { name: nameInput.trim() });
      setUser({ ...user, name: nameInput.trim() });
      addToast('Name updated successfully! 👤', 'success');
      setEditingName(false);
    } catch {
      addToast('Failed to update name.', 'error');
    } finally {
      setSavingName(false);
    }
  }

  const roleLabel: Record<string, string> = {
    user: 'Customer',
    vendor: 'Tiffin Vendor',
    delivery: 'Delivery Agent',
    admin: 'Administrator',
  };

  const menuItems = [
    { icon: '🎁', label: 'Refer & Earn', href: '/referrals' },
    { icon: '🎫', label: 'Support & Help', href: '/support' },
    { icon: '📦', label: 'My Subscriptions', href: '/orders' },
  ];

  return (
    <div className="animate-fade-in pr-4 pl-4">
      <div className="mb-5">
        <h1 className="text-[30px] sm:text-[36px] font-black text-slate-900 tracking-tight leading-tight">My Profile</h1>
        <p className="text-sm text-slate-500 mt-0.5">Identity, account access, and quick links</p>
      </div>


      {/* Profile Header */}
      <div className="flex items-center gap-4 bg-white rounded-3xl p-5 shadow-card mb-5">
        <div 
          onClick={() => fileInputRef.current?.click()}
          className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 border border-slate-200/50 flex items-center justify-center text-slate-700 text-2xl font-bold shadow-sm overflow-hidden cursor-pointer group shrink-0"
        >
          {user?.image ? (
            <Image 
              src={getImageUrl(user.image)} 
              alt={user.name || 'Profile'} 
              fill 
              className="object-cover" 
              unoptimized
            />
          ) : (
            <span>{user?.name?.[0]?.toUpperCase() ?? '?'}</span>
          )}
          
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <span className="text-white text-[9px] font-black uppercase tracking-widest text-center leading-tight">Edit</span>
          </div>

          {loadingImage && (
            <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex items-center justify-center">
              <div className="w-5 h-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          accept="image/*" 
          onChange={handleImageChange} 
        />
        {editingName ? (
          <div className="flex-1 min-w-0">
            <input
              className="input py-2 px-3 text-sm font-semibold max-w-[200px]"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Your Name"
              autoFocus
            />
            <div className="flex gap-2 mt-1.5">
              <button 
                onClick={handleSaveName}
                disabled={savingName}
                className="text-[10px] font-black text-brand uppercase tracking-wider hover:underline"
              >
                {savingName ? 'Saving...' : 'Save'}
              </button>
              <button 
                onClick={() => { setEditingName(false); setNameInput(user?.name || ''); }}
                className="text-[10px] font-black text-slate-400 uppercase tracking-wider hover:underline"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-slate-900 leading-none truncate max-w-[185px]">
                {user?.name || 'Set your name'}
              </h2>
              <button 
                onClick={() => setEditingName(true)}
                className="text-slate-400 hover:text-slate-650 transition-colors text-xs"
                aria-label="Edit name"
              >
                ✏️
              </button>
            </div>
            <p className="text-sm text-slate-500 font-medium mt-1.5">+91 {formatPhone(user?.phone)}</p>
            <span className="badge bg-brand-50 text-brand text-xs mt-1">
              {roleLabel[user?.role ?? 'user'] ?? user?.role}
            </span>
          </div>
        )}
      </div>

      {/* Active Subscriptions / Days Remaining */}
      {activeSubscriptions.length > 0 && (
        <div className="bg-white rounded-3xl p-5 shadow-card mb-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-slate-900">Active Subscriptions</h3>
            <Calendar className="w-5 h-5 text-slate-400" />
          </div>
          
          <div className="space-y-4">
            {activeSubscriptions.map(sub => {
              const frequency = sub.frequency || 'weekly';
              const daysInCycle = frequency === 'monthly' ? 30 : 7;
              
              let currentNextBilling = sub.next_billing_date?.toDate?.();
              if (!currentNextBilling) {
                const createdDate = sub.created_at?.toDate?.() || new Date();
                currentNextBilling = new Date(createdDate.getTime());
                currentNextBilling.setDate(currentNextBilling.getDate() + daysInCycle);
              }
              
              const now = new Date();
              const diffTime = currentNextBilling.getTime() - now.getTime();
              const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
              
              const isExpiringSoon = diffDays <= 7;

              // Swap Allowance computations
              const allowance = swapAllowances[sub.id];
              const totalSwaps = allowance?.free_swaps_total || 0;
              const usedSwaps = allowance?.free_swaps_used || 0;
              const remainingSwaps = Math.max(0, totalSwaps - usedSwaps);
              const qtyToBuy = purchaseQty[sub.id] || 1;
              
              return (
                <div key={sub.id} className="bg-slate-50 border border-slate-100 rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-bold text-slate-900 capitalize">{sub.meal_type} Meal ({frequency})</span>
                    <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-full ${isExpiringSoon ? 'bg-orange-100 text-orange-600' : 'bg-emerald-100 text-emerald-600'}`}>
                      {diffDays > 0 ? `${diffDays} Days Left` : 'Expired'}
                    </span>
                  </div>
                  
                  <div className="w-full bg-slate-200 rounded-full h-1.5 mb-3 overflow-hidden">
                    <div 
                      className={`h-1.5 rounded-full ${isExpiringSoon ? 'bg-orange-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.max(0, Math.min(100, (diffDays / daysInCycle) * 100))}%` }}
                    />
                  </div>
                  
                  {isExpiringSoon && (
                    <button
                      onClick={() => {
                        setSelectedSubForPayment(sub);
                        setPaymentModalOpen(true);
                      }}
                      className="w-full mt-2 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all duration-200 bg-brand text-white hover:bg-brand-600 active:scale-95 shadow-md shadow-brand/20 mb-3"
                    >
                      <AlertCircle className="w-3.5 h-3.5" />
                      Make Payment
                    </button>
                  )}

                  {/* Buy Swaps Section */}
                  <div className="mt-4 bg-emerald-50 border border-emerald-100 rounded-2xl p-4 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-3 opacity-10 pointer-events-none">
                      <RefreshCw className="w-16 h-16 text-emerald-500" />
                    </div>
                    
                    <div className="relative z-10 flex justify-between items-start mb-3">
                      <div>
                        <h4 className="text-[13px] font-bold text-emerald-900 flex items-center gap-1">
                          Need More Swaps?
                        </h4>
                        <p className="text-[10px] text-emerald-700/80 mt-0.5 leading-tight max-w-[180px]">
                          Flexibility to swap meals anytime & keep earning rewards!
                        </p>
                      </div>
                      <div className="bg-white px-2 py-1 rounded-lg border border-emerald-200/60 shadow-sm flex flex-col items-center justify-center min-w-[50px]">
                        <span className="text-[10px] font-bold text-slate-400 uppercase leading-none">Left</span>
                        <span className="text-sm font-black text-emerald-600 leading-none mt-0.5">{remainingSwaps}</span>
                      </div>
                    </div>

                    <div className="relative z-10 space-y-3">
                      {/* Presets */}
                      <div className="grid grid-cols-3 gap-2">
                        {[1, 3, 5].map((packQty) => (
                          <button
                            key={packQty}
                            onClick={() => setPurchaseQty(prev => ({ ...prev, [sub.id]: packQty }))}
                            className={`py-1.5 rounded-xl border text-[10px] font-bold transition-all ${
                              qtyToBuy === packQty 
                                ? 'bg-emerald-500 border-emerald-600 text-white shadow-md shadow-emerald-500/20' 
                                : 'bg-white border-emerald-200/60 text-emerald-700 hover:bg-emerald-100'
                            }`}
                          >
                            {packQty} {packQty === 1 ? 'Swap' : 'Swaps'}
                          </button>
                        ))}
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="flex items-center bg-white rounded-xl px-1.5 py-1 border border-emerald-200/60 shadow-sm">
                          <button 
                            onClick={() => handleSwapQtyChange(sub.id, -1)}
                            className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-emerald-600 font-bold active:scale-95 transition-transform focus:outline-none"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="w-6 text-center text-xs font-black text-slate-800">{qtyToBuy}</span>
                          <button 
                            onClick={() => handleSwapQtyChange(sub.id, 1)}
                            className="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-emerald-600 font-bold active:scale-95 transition-transform focus:outline-none"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>

                        <button
                          onClick={() => handleBuySwaps(sub.id)}
                          disabled={buyingSwapId !== null}
                          className="flex-1 py-2.5 bg-emerald-500 text-white text-[11px] font-black uppercase tracking-wider rounded-xl hover:bg-emerald-600 shadow-md shadow-emerald-500/25 transition-all flex items-center justify-center gap-1.5 active:scale-95 disabled:opacity-70 focus:outline-none"
                        >
                          {buyingSwapId === sub.id ? (
                            <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          ) : (
                            `Buy ${qtyToBuy} Swaps • ₹${qtyToBuy * 29}`
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Expired Subscriptions — renew state */}
      {expiredSubscriptions.length > 0 && (
        <div className="bg-white rounded-3xl p-5 shadow-card mb-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-slate-900">Expired Subscriptions</h3>
            <AlertCircle className="w-5 h-5 text-amber-500" />
          </div>
          <div className="space-y-4">
            {expiredSubscriptions.map(sub => {
              let currentNextBilling = sub.next_billing_date?.toDate?.();
              const expiredOn = currentNextBilling
                ? currentNextBilling.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                : '—';
              return (
                <div key={sub.id} className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-bold text-slate-900 capitalize">{sub.meal_type} Meal ({sub.frequency || 'weekly'})</span>
                    <span className="text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-full bg-amber-100 text-amber-700">
                      Expired
                    </span>
                  </div>
                  <p className="text-[11px] text-amber-800/70 font-medium mb-3">
                    Benefits ended on {expiredOn}. Renew to reactivate meals, tracking and rewards.
                  </p>
                  <button
                    onClick={() => {
                      setSelectedSubForPayment(sub);
                      setPaymentModalOpen(true);
                    }}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all duration-200 bg-amber-500 text-white hover:bg-amber-600 active:scale-95 shadow-md shadow-amber-500/20"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Renew Subscription
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Rewards / Credits Single Button */}
      <div 
        onClick={() => setIsRewardsModalOpen(true)}
        className="bg-white rounded-3xl p-4 shadow-card mb-5 flex items-center gap-4 cursor-pointer hover:bg-slate-50 transition-colors active:scale-[0.98]"
      >
        <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center shrink-0">
          <Gift className="w-6 h-6 text-amber-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-bold text-slate-900 leading-tight">My Rewards & Credits</h3>
            <div className="flex items-center gap-1 bg-amber-50 border border-amber-100 rounded-full px-2 py-0.5">
              <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
              <span className="text-[11px] font-black text-amber-700">{totalCredits} cr</span>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-1 truncate">Earn free meals & manage credits</p>
        </div>
        <ChevronRight className="w-5 h-5 text-slate-300 shrink-0" />
      </div>

      {/* Delivery Preferences */}
      <div className="bg-white rounded-3xl p-5 shadow-card mb-5">
        <h3 className="text-[15px] font-bold text-slate-900 mb-1">Lunch Delivery Slot</h3>
        <p className="text-[11px] text-slate-500 mb-4 leading-tight">
          Applies to tomorrow's scheduled orders.
        </p>
        
        <div className="flex bg-slate-100 p-1 rounded-2xl relative">
          <button
            onClick={() => updatePreference('8am')}
            className={`flex-1 py-2.5 text-xs font-bold rounded-xl transition-all focus:outline-none active:scale-[0.98] ${
              user?.deliveryPreference === '8am' || !user?.deliveryPreference
                ? 'bg-white text-brand shadow-sm ring-1 ring-black/5'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            8:00 AM
          </button>
          <button
            onClick={() => updatePreference('11am')}
            className={`flex-1 py-2.5 text-xs font-bold rounded-xl transition-all focus:outline-none active:scale-[0.98] ${
              user?.deliveryPreference === '11am'
                ? 'bg-white text-brand shadow-sm ring-1 ring-black/5'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            11:00 AM
          </button>
        </div>
      </div>

      {/* Menu Items */}
      <div className="bg-white rounded-3xl shadow-card overflow-hidden mb-5">
        {menuItems.map((item, i) => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-4 px-5 py-4 hover:bg-slate-50 transition-colors ${i > 0 ? 'border-t border-slate-100' : ''}`}
          >
            <span className="text-xl">{item.icon}</span>
            <span className="flex-1 text-sm font-semibold text-slate-800">{item.label}</span>
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </Link>
        ))}
      </div>

      {/* Logout */}
      <button onClick={handleLogout} className="w-full py-3.5 font-semibold rounded-2xl bg-rose-50 text-rose-600 border border-rose-100 hover:bg-rose-100 transition-colors">
        Sign Out
      </button>

      <p className="text-center text-xs text-slate-400 mt-6 mb-10">Dabzzo v2.0 • Smart Meal Subscriptions</p>
      
      {selectedSubForPayment && (
        <PaymentModal 
          isOpen={paymentModalOpen}
          onClose={() => setPaymentModalOpen(false)}
          subscription={selectedSubForPayment}
          amount={selectedSubForPayment.planPrice || selectedSubForPayment.price || (selectedSubForPayment.frequency === 'monthly' ? 2400 : 600)}
          onSuccess={() => {
            setPaymentModalOpen(false);
            addToast('Payment successful! Subscription renewed.', 'success');
          }}
        />
      )}

      {/* Rewards Popup Modal */}
      <RewardsModal
        isOpen={isRewardsModalOpen}
        onClose={() => setIsRewardsModalOpen(false)}
        totalCredits={totalCredits}
        creditHistory={creditHistory}
        activeSubscriptions={activeSubscriptions}
        onRedeem={handleRedeem}
        redeemingCredits={redeemingCredits}
      />
    </div>
  );
}
