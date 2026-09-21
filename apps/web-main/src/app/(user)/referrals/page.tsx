'use client';

import { useCallback, useEffect, useState } from 'react';
import { Gift, Copy, Share2, Check, Lock, PartyPopper, Loader2, Users } from 'lucide-react';
import { useUiStore } from '@/store/uiStore';
import {
  getReferralDashboardData,
  claimReferralMilestone,
} from '@/lib/queries/referrals';
import { REFERRAL_MILESTONES } from '@dabzzo/shared-lib/referrals';
import type { ReferralDashboardData, ReferralMilestoneStatus } from '@/types';

const totalReferralTarget = Math.max(...REFERRAL_MILESTONES.map((m) => m.threshold));

export default function ReferralsPage() {
  const addToast = useUiStore((s) => s.addToast);
  const [data, setData] = useState<ReferralDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [reward, setReward] = useState<{ couponCode: string; discountPercentage: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await getReferralDashboardData();
      setData(res);
    } catch {
      addToast('Could not load your referral progress.', 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const copyText = async (text: string, key: 'link' | 'code') => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      addToast('Copy failed — select & copy manually.', 'warning');
      return;
    }
    if (key === 'link') {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } else {
      setCopiedCode(text);
      setTimeout(() => setCopiedCode(null), 1800);
    }
    addToast('Copied to clipboard! 📋', 'success');
  };

  const shareLink = async () => {
    if (!data) return;
    const share = {
      title: 'Dabzzo — Get 10/15/20% OFF Tiffin Plans',
      text: `Fresh home-cooked tiffins, and we both earn. Use my code ${data.referralCode} when you sign up!`,
      url: data.referralLink,
    };
    if (navigator.share) {
      try { await navigator.share(share); } catch { /* cancelled by user */ }
    } else {
      await copyText(data.referralLink, 'link');
    }
  };

  const handleClaim = async (milestoneId: string) => {
    if (claimingId) return;
    setClaimingId(milestoneId);
    try {
      const res = await claimReferralMilestone(milestoneId);
      setReward(res);
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not claim this reward.';
      addToast(msg, 'error');
    } finally {
      setClaimingId(null);
    }
  };

  const progressPct = data
    ? Math.min(100, Math.round((data.completedReferrals / totalReferralTarget) * 100))
    : 0;

  return (
    <div className="animate-fade-in pr-4 pl-4 max-w-2xl mx-auto pb-10">
      <div className="mb-5">
        <h1 className="text-[30px] sm:text-[36px] font-black text-slate-900 tracking-tight leading-tight">Refer &amp; Earn</h1>
        <p className="text-sm text-slate-500 mt-0.5">Invite friends, unlock one-time rewards on monthly plans</p>
      </div>

      {/* Hero — referral link */}
      <div className="bg-gradient-to-br from-amber-500 to-orange-600 rounded-3xl p-6 text-white shadow-lg shadow-amber-500/25 mb-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center">
            <Gift className="w-5 h-5" />
          </div>
          <p className="text-sm font-bold leading-tight">
            Everyone pays ₹1400+/mo. You save when they subscribe after using your code.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm font-bold opacity-80">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading your code…
          </div>
        ) : data ? (
          <>
            <div className="flex items-center justify-between bg-white/15 border border-white/20 rounded-2xl px-4 py-3 mb-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Your code</p>
                <p className="text-2xl font-black tracking-widest">{data.referralCode}</p>
              </div>
              <button
                onClick={() => copyText(data.referralCode, 'code')}
                className="flex items-center gap-1.5 bg-white text-amber-700 rounded-xl px-3.5 py-2.5 text-xs font-black uppercase tracking-wide hover:bg-amber-50 transition-colors cursor-pointer"
              >
                {copiedCode === data.referralCode ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copiedCode === data.referralCode ? 'Copied' : 'Copy'}
              </button>
            </div>

            <div className="flex gap-2">
              <button
                onClick={shareLink}
                className="flex-1 flex items-center justify-center gap-2 bg-slate-950/30 hover:bg-slate-950/40 border border-white/25 rounded-2xl py-3 text-xs font-black uppercase tracking-widest transition-colors cursor-pointer"
              >
                <Share2 className="w-4 h-4" /> Share
              </button>
              <button
                onClick={() => copyText(data.referralLink, 'link')}
                className="flex-1 flex items-center justify-center gap-2 bg-white hover:bg-amber-50 text-amber-800 rounded-2xl py-3 text-xs font-black uppercase tracking-widest transition-colors cursor-pointer"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Link Copied' : 'Copy Link'}
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm font-bold opacity-80">Tap retry to reload.</p>
        )}
      </div>

      {/* Progress */}
      <div className="bg-white rounded-3xl p-5 shadow-card mb-5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-brand" />
            <p className="text-sm font-black text-slate-800">Successful referrals</p>
          </div>
          <span className="text-xl font-black text-brand">
            {data ? data.completedReferrals : '–'}
            <span className="text-xs font-bold text-slate-400"> / {totalReferralTarget}</span>
          </span>
        </div>
        <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full transition-all duration-700"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <p className="text-[11px] text-slate-400 font-medium mt-2">
          A referral counts once the invited friend subscribes to any plan. Only monthly plans qualify for coupons.
        </p>
      </div>

      {/* Milestone tiers */}
      <p className="text-xs font-black uppercase tracking-widest text-slate-400 mb-3">Reward Tiers</p>
      <div className="space-y-3">
        {REFERRAL_MILESTONES.map((m) => (
          <MilestoneCard
            key={m.id}
            milestone={m}
            status={data?.milestones.find((s) => s.id === m.id)}
            completedReferrals={data?.completedReferrals ?? 0}
            claiming={claimingId === m.id}
            onClaim={() => handleClaim(m.id)}
            onCopy={(code) => copyText(code, 'code')}
            copiedCode={copiedCode}
          />
        ))}
      </div>

      {/* Claim success modal */}
      {reward && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm" onClick={() => setReward(null)} />
          <div className="relative w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl text-center animate-fade-in">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-amber-100 flex items-center justify-center mb-4">
              <PartyPopper className="w-7 h-7 text-amber-600" />
            </div>
            <h3 className="text-lg font-black text-slate-900">Reward Unlocked! 🎉</h3>
            <p className="text-sm text-slate-500 mt-1">
              {reward.discountPercentage}% OFF one monthly plan
            </p>
            <div className="mt-4 p-3 bg-slate-50 rounded-2xl">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Your coupon</p>
              <p className="text-xl font-black tracking-widest text-amber-800">{reward.couponCode}</p>
            </div>
            <p className="text-[11px] text-slate-400 font-medium mt-3">
              Valid on monthly subscriptions only · one-time use · enter it in the checkout coupon field.
            </p>
            <button
              onClick={() => copyText(reward.couponCode, 'code')}
              className="mt-5 w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 text-white rounded-2xl py-3.5 text-sm font-black uppercase tracking-widest transition-colors cursor-pointer"
            >
              {copiedCode === reward.couponCode ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copiedCode === reward.couponCode ? 'Copied!' : 'Copy Coupon'}
            </button>
            <button
              onClick={() => setReward(null)}
              className="mt-2 w-full text-xs font-bold text-slate-400 hover:text-slate-600 py-2 cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MilestoneCard({
  milestone,
  status,
  completedReferrals,
  claiming,
  onClaim,
  onCopy,
  copiedCode,
}: {
  milestone: { id: string; threshold: number; discount: number };
  status?: ReferralMilestoneStatus;
  completedReferrals: number;
  claiming: boolean;
  onClaim: () => void;
  onCopy: (code: string) => void;
  copiedCode: string | null;
}) {
  const unlocked = (completedReferrals ?? 0) >= milestone.threshold;
  const claimed = Boolean(status?.claimed);

  return (
    <div
      className={`rounded-3xl border-2 p-5 transition-all ${
        claimed
          ? 'border-emerald-200 bg-emerald-50/40'
          : unlocked
            ? 'border-amber-300 bg-amber-50/40'
            : 'border-slate-100 bg-white'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div
            className={`w-11 h-11 rounded-2xl flex items-center justify-center text-lg font-black ${
              claimed ? 'bg-emerald-100 text-emerald-700' : unlocked ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'
            }`}
          >
            {claimed ? <Check className="w-5 h-5" /> : unlocked ? <PartyPopper className="w-5 h-5" /> : <Lock className="w-5 h-5" />}
          </div>
          <div>
            <p className="text-sm font-black text-slate-900">{milestone.threshold} successful referrals</p>
            <p className="text-xs text-slate-400 font-semibold">
              {claimed ? 'Reward claimed' : unlocked ? 'Unlocked — ready to claim' : `${completedReferrals}/${milestone.threshold} reached`}
            </p>
          </div>
        </div>
        <span className="text-lg font-black text-amber-700">{milestone.discount}% OFF</span>
      </div>

      <p className="text-[11px] text-slate-400 font-medium mb-3">
        One-time coupon for any Dabzzo monthly subscription plan.
      </p>

      {claimed && status?.couponCode ? (
        <button
          onClick={() => onCopy(status.couponCode!)}
          className="w-full flex items-center justify-between bg-white border border-emerald-200 rounded-2xl px-4 py-3 cursor-pointer hover:border-emerald-300 transition-colors"
        >
          <span className="text-sm font-black tracking-widest text-emerald-800">{status.couponCode}</span>
          <span className="flex items-center gap-1 text-xs font-black text-emerald-700">
            {copiedCode === status.couponCode ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copiedCode === status.couponCode ? 'Copied' : 'Copy'}
          </span>
        </button>
      ) : (
        <button
          onClick={onClaim}
          disabled={!unlocked || claiming}
          className={`w-full rounded-2xl py-3.5 text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40 ${
            unlocked
              ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-md shadow-amber-500/25'
              : 'bg-slate-100 text-slate-400'
          }`}
        >
          {claiming ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Claiming…
            </>
          ) : unlocked ? (
            'Claim Reward'
          ) : (
            `Locked — invite ${milestone.threshold - completedReferrals} more`
          )}
        </button>
      )}
    </div>
  );
}