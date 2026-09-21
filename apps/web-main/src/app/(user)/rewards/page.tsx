'use client';

import { useState, useEffect } from 'react';
import { useAuthStore } from '@/store/authStore';
import { Gift, AlertCircle, ChevronRight, CheckCircle2, Ticket, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { redeemVoucher } from '@/lib/queries/rewards';
import toast from 'react-hot-toast';
import { getErrorMessage } from '@dabzzo/shared-lib/errors';
import { isSubscriptionActive } from '@dabzzo/shared-lib/subscriptionEntitlement';

export default function RewardsPage() {
  const user = useAuthStore(s => s.user);
  const [totalCredits, setTotalCredits] = useState<number>(0);
  const [availableVouchers, setAvailableVouchers] = useState<any[]>([]);
  const [hasActiveSubscription, setHasActiveSubscription] = useState(false);
  const [activeSubscriptionId, setActiveSubscriptionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setLoading(true);

    const creditsQ = query(collection(db, 'user_credits'), where('user_id', '==', user.id));
    const vouchersQ = query(collection(db, 'free_meal_vouchers'), where('user_id', '==', user.id), where('status', '==', 'available'));
    const subsQ = query(collection(db, 'subscriptions'), where('user_id', '==', user.id), where('status', '==', 'active'));

    const unsubCredits = onSnapshot(creditsQ, (snap) => {
      let total = 0;
      snap.docs.forEach(d => { const c = d.data() as any; if (!c.redeemed) total += (c.credit_amount || 0); });
      setTotalCredits(Math.round(total * 10) / 10);
    }, console.error);

    const unsubVouchers = onSnapshot(vouchersQ, (snap) => {
      setAvailableVouchers(snap.docs.map(d => ({ id: d.id, ...d.data() } as any)));
    }, console.error);

    const unsubSubs = onSnapshot(subsQ, (snap) => {
      // Entitlement-aware: expired-but-stored-active subs must not enable
      // voucher redemption (which grants more subscription days).
      const nowMs = Date.now();
      const validSubs = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as any))
        .filter(s => isSubscriptionActive(s, nowMs));
      setHasActiveSubscription(validSubs.length > 0);
      setActiveSubscriptionId(validSubs[0]?.id ?? null);
      setLoading(false);
    }, console.error);

    return () => {
      unsubCredits();
      unsubVouchers();
      unsubSubs();
    };
  }, [user]);

  const handleRedeemVoucher = async (voucherId: string) => {
    if (!user || !activeSubscriptionId) return;
    setRedeemingId(voucherId);
    try {
      await redeemVoucher(user.id, voucherId, activeSubscriptionId);
      toast.success('Voucher redeemed! Added 1 day to your subscription. 🎉');
    } catch (err: unknown) {
      console.error(err);
      toast.error(getErrorMessage(err) || 'Failed to redeem voucher.');
    } finally {
      setRedeemingId(null);
    }
  };

  if (loading) {
    return (
      <div className="p-4 pt-10 flex justify-center">
        <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  const progressPercentage = Math.min((totalCredits / 1.0) * 100, 100);

  return (
    <div className="animate-fade-in pb-24">
      {/* Header */}
      <div className="mt-4 mb-8 px-4 flex flex-col gap-2">
        <h1 className="text-3xl font-black text-slate-900 tracking-tight leading-tight flex items-center gap-2">
          Rewards <Gift className="w-6 h-6 text-brand" />
        </h1>
        <p className="text-sm font-medium text-slate-500">
          Earn credits by swapping meals and redeem them for free food!
        </p>
      </div>

      {/* Credit Progress */}
      <div className="px-4 mb-8">
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100">
          <div className="flex justify-between items-end mb-4">
            <div>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Current Balance</p>
              <p className="text-4xl font-black text-slate-900">{totalCredits.toFixed(1)} <span className="text-lg text-slate-400 font-bold">/ 1.0</span></p>
            </div>
            <div className="w-12 h-12 rounded-full bg-brand/10 flex items-center justify-center">
              <span className="text-2xl">🍕</span>
            </div>
          </div>
          
          <div className="h-3 w-full bg-slate-100 rounded-full overflow-hidden mb-3">
            <div 
              className="h-full bg-brand transition-all duration-1000 ease-out"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
          
          <p className="text-xs font-medium text-slate-500">
            {totalCredits >= 1.0 
              ? "You've earned a free meal voucher!" 
              : `Earn ${(1.0 - totalCredits).toFixed(1)} more credits for a free meal.`}
          </p>
        </div>
      </div>

      {/* Vouchers */}
      <div className="px-4">
        <h3 className="font-bold text-slate-900 mb-4 text-lg">Your Vouchers</h3>
        
        {availableVouchers.length === 0 ? (
          <div className="bg-slate-50 border border-slate-100 rounded-3xl p-8 flex flex-col items-center justify-center text-center">
            <Ticket className="w-10 h-10 text-slate-300 mb-3" />
            <p className="font-bold text-slate-900">No vouchers yet</p>
            <p className="text-xs text-slate-500 mt-1 max-w-[200px]">Keep swapping meals to earn credits and unlock free meal vouchers!</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {availableVouchers.map((v, i) => (
              <div key={v.id} className="bg-emerald-50 border border-emerald-100 rounded-3xl p-5 flex flex-col relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-10">
                  <Ticket className="w-20 h-20 text-emerald-900" />
                </div>
                
                <div className="flex items-center gap-2 mb-1 relative z-10">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <p className="text-xs font-bold text-emerald-600 uppercase tracking-widest">Available</p>
                </div>
                <h4 className="text-xl font-black text-emerald-900 mb-4 relative z-10">Free Meal Voucher</h4>
                
                {hasActiveSubscription ? (
                  <button 
                    onClick={() => handleRedeemVoucher(v.id)}
                    disabled={redeemingId === v.id}
                    className="bg-emerald-600 text-white rounded-xl py-3 font-bold text-sm w-full shadow-md hover:shadow-lg transition-all active:scale-[0.98] relative z-10 flex items-center justify-center gap-2"
                  >
                    {redeemingId === v.id ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" /> Redeeming...
                      </>
                    ) : 'Redeem Voucher'}
                  </button>
                ) : (
                  <button disabled className="bg-slate-200 text-slate-400 rounded-xl py-3 font-bold text-sm w-full relative z-10 cursor-not-allowed">
                    Subscription Required
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Subscription Warning */}
      {!hasActiveSubscription && (availableVouchers.length > 0 || totalCredits > 0) && (
        <div className="px-4 mt-6">
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex gap-3 items-start">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-amber-900">Subscription Inactive</p>
              <p className="text-xs text-amber-700 mt-1">
                You have {totalCredits > 0 ? `${totalCredits} credits` : ''} 
                {totalCredits > 0 && availableVouchers.length > 0 ? ' and ' : ''}
                {availableVouchers.length > 0 ? `${availableVouchers.length} vouchers` : ''} waiting. 
                Resubscribe to redeem them!
              </p>
              <Link href="/dashboard" className="text-xs font-bold text-brand mt-2 inline-flex items-center gap-1 hover:underline">
                View Plans <ChevronRight className="w-3 h-3" />
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

