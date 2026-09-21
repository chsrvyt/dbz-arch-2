'use client';

import { EmailPasswordForm } from '@dabzzo/shared-ui/auth/EmailPasswordForm';
import { useState, useCallback } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { useUiStore } from '@/store/uiStore';
import { signInWithGoogle } from '@/lib/auth';
import { resolveUserProfile, completeOnboarding, markPhonePromptShown } from '@/lib/queries/users';
import { applyReferralCode } from '@/lib/queries/referrals';
import { migrateSubscriptions } from '@/lib/queries/subscriptions';
import type { UserRole } from '@/types';
import type { User } from 'firebase/auth';
import { ArrowRight } from 'lucide-react';
import { getErrorMessage } from '@dabzzo/shared-lib/errors';

type AuthStep = 'social' | 'phone-capture';

const GoogleIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

export default function LoginPage() {
  const router = useRouter();
  const setUser = useAuthStore((s) => s.setUser);
  const addToast = useUiStore((s) => s.addToast);

  const [step, setStep] = useState<AuthStep>('social');
  const [loading, setLoading] = useState(false);
  const [phone, setPhone] = useState('');
  const [pendingUser, setPendingUser] = useState<User | null>(null);
  const [prefillName, setPrefillName] = useState('');
  const [prefillEmail, setPrefillEmail] = useState<string | null>(null);
  const [prefillPhoto, setPrefillPhoto] = useState<string | null>(null);
  const [savingPhone, setSavingPhone] = useState(false);

  const handleAuthSuccess = useCallback(async (firebaseUser: User) => {
    try {
      const { user: profile, isNewUser } = await resolveUserProfile(
        firebaseUser.uid,
        firebaseUser.email,
        firebaseUser.displayName,
        firebaseUser.photoURL,
      );

      if (!isNewUser) {
        setUser(profile);
        addToast(`Welcome back, ${profile.name || 'Foodie'}! 🎉`, 'success');
        try { await migrateSubscriptions(firebaseUser.uid); } catch {}
        const paths: Record<string, string> = {
          admin: '/admin/dashboard',
          vendor: '/dashboard',
          delivery: '/dashboard',
          user: '/dashboard',
        };
        router.replace(paths[profile.role] || '/dashboard');
        return;
      }

      setPendingUser(firebaseUser);
      setPrefillName(firebaseUser.displayName || '');
      setPrefillEmail(firebaseUser.email || null);
      setPrefillPhoto(firebaseUser.photoURL || null);
      setStep('phone-capture');

      // Record that we asked, as soon as the prompt appears rather than on
      // submit. That makes it strictly one-time: abandoning the form does not
      // earn another prompt on the next sign-in. Fire-and-forget so it never
      // delays showing the screen.
      void markPhonePromptShown(firebaseUser.uid);
    } catch (err: unknown) {
      addToast(getErrorMessage(err) || 'Sign-in failed. Please try again.', 'error');
    }
  }, [setUser, addToast, router]);

  const handleGoogle = async () => {
    setLoading(true);
    try {
      const result = await signInWithGoogle();
      if (!result.success) { addToast(result.error, 'error'); return; }
      await handleAuthSuccess(result.user);
    } finally { setLoading(false); }
  };

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phone.length !== 10) { addToast('Enter a valid 10-digit number', 'warning'); return; }
    if (!pendingUser) return;

    setSavingPhone(true);
    try {
      const user = await completeOnboarding(
        pendingUser.uid,
        `+91${phone}`,
        prefillName || 'User',
        'user' as UserRole,
        prefillEmail,
        prefillPhoto,
      );
      setUser(user);
      addToast(`Welcome to Dabzzo, ${user.name || 'Foodie'}! 🎉`, 'success');

      // Referral attribution: if this sign-up came from a ?ref=CODE link,
      // record it server-side (fire-and-forget; server validates + dedupes).
      const refCode = new URLSearchParams(window.location.search).get('ref');
      if (refCode) {
        try { await applyReferralCode(refCode); } catch { /* ignore */ }
      }

      router.replace('/dashboard');
    } catch (err: unknown) {
      addToast(getErrorMessage(err) || 'Setup failed. Try again.', 'error');
    } finally {
      setSavingPhone(false);
    }
  };

  return (
    <div className="min-h-dvh bg-[#F8FAFC] flex flex-col justify-center px-6 py-10 font-sans">
      <div className="w-full max-w-md mx-auto flex flex-col">

        <div className="flex justify-center mb-10">
          <Image
            src="/logo-main-text.png"
            alt="Dabzzo"
            width={340}
            height={95}
            priority
            unoptimized
            className="h-16 sm:h-20 w-auto object-contain"
          />
        </div>

        <div className="bg-white border border-slate-100 rounded-3xl p-8 shadow-[0_12px_36px_rgba(0,0,0,0.05)]">

          {step === 'social' && (
            <div className="flex flex-col items-center gap-6 animate-fade-in">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                Sign in to continue
              </p>

              <button
                onClick={handleGoogle}
                disabled={loading}
                className="w-full flex items-center gap-3 bg-white border-2 border-slate-100 hover:border-slate-200 hover:bg-slate-50 text-slate-800 font-semibold text-sm py-3.5 px-5 rounded-2xl transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {loading
                  ? <div className="w-5 h-5 rounded-full border-2 border-slate-200 border-t-slate-600 animate-spin" />
                  : <GoogleIcon />}
                <span className="flex-1 text-center">Continue with Google</span>
              </button>

              <div className="flex items-center gap-3 w-full">
                <span className="h-px flex-1 bg-slate-200" />
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">or</span>
                <span className="h-px flex-1 bg-slate-200" />
              </div>

              <div className="w-full">
                <EmailPasswordForm
                  allowSignUp
                  signInLabel="Sign In"
                  accentClassName="bg-slate-900 hover:bg-slate-800"
                  onNotify={(m, k) => addToast(m, k)}
                  onSuccess={(u) => { void handleAuthSuccess(u); }}
                />
              </div>
            </div>
          )}

          {step === 'phone-capture' && (
            <form onSubmit={handlePhoneSubmit} className="space-y-5 animate-fade-in">
              {prefillPhoto && (
                <div className="flex justify-center mb-2">
                  <img src={prefillPhoto} alt={prefillName} className="w-14 h-14 rounded-full ring-2 ring-brand/20 object-cover" />
                </div>
              )}
              <div className="text-center mb-4">
                <p className="text-base font-bold text-slate-800">
                  Hi, {prefillName || 'there'} 👋
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  One last step — your number helps riders reach you
                </p>
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-500 uppercase tracking-widest block mb-2 ml-1">
                  Mobile Number
                </label>
                <div className="flex items-center bg-slate-50 border-2 border-slate-100 rounded-2xl px-4 py-3.5 focus-within:bg-white focus-within:border-[#E68A00] focus-within:shadow-[0_0_0_4px_rgba(230,138,0,0.12)] transition-all duration-300">
                  <span className="text-base font-black text-slate-400 select-none mr-3">+91</span>
                  <div className="w-px h-5 bg-slate-200 mr-3" />
                  <input
                    type="tel"
                    inputMode="numeric"
                    maxLength={10}
                    placeholder="10 digit number"
                    autoFocus
                    className="w-full bg-transparent text-base font-bold text-slate-900 outline-none placeholder:text-slate-400 placeholder:font-normal"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={savingPhone || phone.length !== 10}
                className="w-full bg-[#E68A00] text-white font-bold text-base py-4 rounded-2xl transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-lg shadow-[#E68A00]/25 disabled:opacity-50 hover:bg-[#D97706]"
              >
                {savingPhone
                  ? <div className="w-5 h-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  : <><span>Get Started</span><ArrowRight className="w-4 h-4" strokeWidth={2.5} /></>}
              </button>
            </form>
          )}
        </div>

        <p className="mt-8 text-center text-[11px] text-slate-400 font-medium">
          Dabzzo · Fresh Home Cooked Tiffins
        </p>

      </div>
    </div>
  );
}