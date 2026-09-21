# Dabzzo v2 — Implementation Plan (Fix, Harden, Deploy)

**Status:** Draft for review · **Owner:** Engineering · **Generated:** 2026-09-12
**Scope:** Get the 5-app monorepo + Cloud Functions backend from "feature-complete, drifted, undocumented" to "verified, deduplicated, deployment-ready."

This document is the single source of truth for the work. Every phase lists exact files touched, why, and what "done" looks like. As phases land, tick the checkboxes and log the change in [CHANGELOG.md](CHANGELOG.md).

---

## Status — 2026-09-12

| Phase | State |
|---|---|
| 0 — Safety net | ✅ Complete |
| 1 — Canonicalize shared code | ✅ Complete (~46,000 lines removed) |
| 2 — Security & rules | ✅ Complete |
| 3 — Lint & correctness | 🟡 Partial — correctness rules (`purity`, `immutability`) **cleared**; `no-explicit-any`/`no-unused-vars` bulk remains |
| 4 — Test coverage | ✅ Complete — 47 → **99 tests**, 3 → 7 suites |
| 5 — Documentation | ✅ Complete |
| 6 — Deployment readiness | ✅ [DEPLOYMENT.md](DEPLOYMENT.md) written; blockers listed there |

**`npm run verify` right now:** typecheck ✅ (apps + packages), functions typecheck ✅, lint ❌ (known), functions tests ✅ **99/99**. All 5 apps build.

### Update — 2026-09-22 (Phase 26: product hardening)

- **Delivery-transition integrity (P0).** The rider callable `updateDeliveryStatus` accepted any status string and blind-wrote it when it didn't match a transition guard — verified `DELIVERED → ASSIGNED` etc. was possible. Target statuses are now whitelisted to the four rider-legitimate ones (`picked_up`, `out_for_delivery`, `delivered`, `failed_attempt`) with an `invalid-argument` rejection before any read/write.
- **One order-lifecycle source of truth.** New `packages/shared-lib/src/orderLifecycle.ts` supplies the canonical status sets (`LIVE_TRACKING_STATUSES`, `DELIVERED_STATUSES`, `INACTIVE_STATUSES`, `ACTIVE_ORDER_STATUSES`), `ORDER_STATUS_LABELS`, `statusToLifecycleStage()`, `isLiveStatus`/`isDeliveredStatus`/`isInactiveStatus`. `track/page.tsx` (previously showed "No Active Delivery" for `created`/`ready` orders and could hang on a failing listener) and `orders/page.tsx` now use it; `RiderTrackingCard` maps all canonical statuses onto its 5 steps.
- **Expiry sweep is auditable.** `auditUtils.writeAuditLog()` (new) appends snake+camel payloads; `expireSubscriptions` logs `subscription.expiry.sweep` per run + `subscription.expiry.user_clear` per user.
- **Vendor + rider ops surface** (from 2026-09-21, now drilled down): `getVendorPrepDetails()` inventory + View-Orders modal with per-order status chips / rider / call links; rider IDLE queue sorted with NEXT badge, "N to go / M done / failed" summary, and `aria-label`s on all icon-only controls.
- **`npm run verify` right now:** typecheck (apps + packages) ✅, functions typecheck ✅, lint (apps + packages) ✅ (0 errors), functions tests ✅ **152/152** (+5: 3 whitelist-pin, 2 auditUtils). Full CHANGELOG entry under **2026-09-22**.

### Update — 2026-09-21 (post-plan product run)

- **Subscription expiry is now enforced at runtime.** The expired-subscription-still-active bug is fixed at the logic level: server + client share one entitlement invariant (`now < next_billing_date` ⇒ active; exactly-at ⇒ expired) in `functions/src/subscriptionExpiry.ts` and `packages/shared-lib/src/subscriptionEntitlement.ts`. An hourly IST sweep cancels over-due subscriptions (`cancelled_by: 'system_expiry'`) and `onSubscriptionCancelled` cascades their future orders; `skipMealOrder` / `undoSkipMealOrder` / `requestMealSwap` reject inactive subscriptions. All customer panels (dashboard/orders/track/profile/rewards/vendor detail, plus the three subscription components), the rider "Your Assigned Deliveries" IDLE view, and the vendor "Today's Preparation" real-order count shipped on top.
- **Cross-tenant read rules closed.** `orders`, `deliveries` and `subscriptions` list/get no longer grant blanket rider/vendor access to every tenant's data — reads are participant-only (`resource.data` must name the caller) unless admin.
- **`npm run verify` right now:** typecheck (apps + packages) ✅, functions typecheck ✅, lint (apps + packages) ✅, functions tests ✅ **147/147**. `npm run test:rules` ✅ **34/34**. Full CHANGELOG entry under 2026-09-21.

### Update — 2026-09-15 (post-plan additions)

- **Repo-wide build blocker cleared.** The duplicate `declare global { Window.Razorpay }` in every app's `src/hooks/useRazorpay.ts` (non-optional, ×4) collided with the canonical optional declaration in `packages/shared-types` → `TS2687`/`TS2717` on every `tsc` and every `next build` in the repo. Per-app duplicates removed; 3 non-web apps (admin/vendor/rider) got a null-guard before `new window.Razorpay` since the canonical property is optional; web-main already used `(window as any)`. Typecheck and all 5 static-export builds now pass. See CHANGELOG 2026-09-15.
- **web-main Track Meal page overhauled** (DELIVERED → new summary card, FAILED → compact not-delivered card, duplicate map removed, notifications behind an Updates toggle, scheduled-slot ETA in `RiderTrackingCard`). Rewards removed from navigation only. See CHANGELOG 2026-09-15 and `apps/web-main/docs/track-page-ux.md`.

### Phase 4 — what the tests found

Coverage went 47 → 99 tests across `utils/geo` (the 2 km dispatch math), `authTriggers.setUserRole`, `adminManagementTriggers` and `swapFunctions`. Two of the security guards were **mutation-checked** — deleting the guard, confirming exactly one test goes red, restoring it — because a mocked `firebase-admin` is easy to get subtly wrong in a way that leaves assertions vacuous.

They earned their keep twice by contradicting an assumption rather than confirming one:

1. **`verifyRider` writes `roles.rider.status` but sets `role: 'delivery'`.** Vendors are symmetric (`roles.vendor` + role `vendor`); riders are not. Nothing anywhere writes `roles.delivery` — which is precisely what the consolidated AuthGuard's delivery branch was checking, making that branch dead. Fixed the guard to check `roles.rider`, so the rider multi-role path actually works.
2. The plan had listed `matchingTriggers`, `payoutTriggers` and `riderPaymentTriggers` as untested. They are covered by `deliveryRedesign.test.ts`. The real gaps were elsewhere.

Still untested: `notificationTriggers`, and `functions/src/__tests__/integration.test.ts` remains the orphaned file described in Phase 0 (it imports the *client* Firestore SDK and paths that don't exist under `functions/`).

### Remaining lint, by rule

| Rule | Count | Nature |
|---|---|---|
| `no-explicit-any` | 510 | Mostly untyped Firestore reads. Real fix is `withConverter<T>()` using the now-canonical shared types. |
| `no-unused-vars` | 370 | Dead imports/params. Mechanical. |
| `set-state-in-effect` | 34 | Triaged — see breakdown below. Performance/idiom rule, not a correctness rule. |
| `no-unescaped-entities` | 28 | Trivial JSX quoting. |
| `exhaustive-deps` | 27 | Stale-closure risk; triage individually. |
| `immutability` / `purity` / `preserve-manual-memoization` / `refs` | 30 | React Compiler correctness rules. Triage individually. |

### React Compiler findings — status

`purity` (8 → **0**) and `immutability` (13 → **0**) are **fixed**. Those were the correctness-bearing ones, and two were genuine bugs: a `Math.random()` React key forcing an unmount/remount every render, and a render-time clock read. See CHANGELOG.

`set-state-in-effect` (34) is **triaged and deliberately deferred.** Its own message says it "causes cascading renders that can hurt performance, and is not recommended" — it is a performance/idiom rule, not a correctness one. The instances break down as:

| Category | Count | Assessment |
|---|---|---|
| Fetch-on-mount (`loadData()`, `loadVendors()`, …) | ~14 | Legitimate. React's own guidance is to adopt Suspense or a data-fetching library — an architecture change, not a lint fix. |
| Loading-flag teardown (`setLoading(false)`) | ~6 | Part of the same fetch pattern. |
| Sync with external system (`new DirectionsService()`, `setPolyline`, `setMounted(true)`) | ~6 | Legitimate effect usage; `setMounted(true)` is the standard hydration guard. |
| **Derive state from props** (`setNameInput(user.name)`, `setProfile({…})`, `setStep(1)`) | **~8** | **The genuine "you might not need an effect" cases.** Worth fixing. |

Only that last group is worth changing, and each one alters UI behaviour subtly (e.g. `setNameInput(user.name)` is what resets a form field when the profile loads — deriving it during render instead can break editing). They need a browser to verify, so they are left for someone who can exercise the screens rather than refactored blind.

The `no-explicit-any` bulk is best addressed with typed Firestore converters (`withConverter<T>()`) now that the shared types are canonical — that would collapse most of the 510 in one structural change rather than 510 edits.

### Open decisions

**D6** (superadmin test-seeding writes fabricated verification data to production Firestore), **D7** (admin UI ships in the public customer bundle), **D8** (bump `next` off 16.2.6 — 1 critical + 2 high advisories) — all detailed below, all still yours to call. Nothing was changed unilaterally on any of them.

---

## 0. Baseline — what's actually true right now

Verified directly (not assumed) on 2026-09-12:

| Check | Result |
|---|---|
| `tsc --noEmit` — web-main, admin-panel, vendor-panel, rider-panel, gig | ✅ **0 errors**, all 5 |
| `tsc --noEmit` — functions | ❌ Fails — **`functions/node_modules` is not installed**, so every `firebase-functions/*` import resolves to nothing. Not a code bug; a setup gap. |
| `eslint` — web-main | ❌ **369 errors / 215 warnings** (311 `no-explicit-any`, 200 `no-unused-vars`, 23 `set-state-in-effect`, 19 `no-unescaped-entities`, 11 `exhaustive-deps`, 5 `purity`, 5 `immutability`) |
| `eslint` — admin-panel | ❌ **296 errors / 227 warnings** (523 total) |
| `eslint` — vendor-panel | ❌ **241 errors / 99 warnings** (340 total) |
| `eslint` — rider-panel | ❌ **230 errors / 88 warnings** (318 total) |
| `eslint` — gig | ❌ **6 errors / 1 warning** (7 total — much smaller app, 3 source files) |
| **Repo-wide lint total** | **1,142 errors / 630 warnings** (1,772 problems) across the 5 apps |
| Git repository | ❌ **None.** No `.git` anywhere in the tree. Nothing is version-controlled yet. |
| TODO/FIXME/HACK markers | 0 across the whole repo |
| `.agents/skills/task.md` | A prior 5-phase security hardening pass, **fully checked off** (rules, auth, rate limiting, cron fixes, vendor mgmt) |
| Cross-app file duplication | 117 files exist in 2–4 apps. **78 byte-identical, 39 have drifted into 2–4 different versions** (see §2) |
| `functions/lib/` (compiled output) | Present but stale — 22 `src/` files are newer than the last build |

**Read as:** the app layer is typescript-clean and previously security-hardened, but the repo has never been put under version control, the functions workspace was never `npm install`-ed, lint debt is real, and the copy-paste-per-app architecture has already produced four different definitions of the core data model. None of this is exotic — it's exactly what you'd expect from four apps bootstrapped by copying one into three, then evolved independently.

---

## 1. Decisions needed from you before I execute

I'll proceed under the **recommended** default for each unless you say otherwise — flagging these now so nothing gets decided silently on your behalf.

| # | Decision | Recommended default | Why |
|---|---|---|---|
| D1 | Initialize git now and commit the current working tree as `chore: initial commit` before any fixes land? | **Yes, do it first** | Nothing is currently recoverable if a fix goes wrong. This is the safety net for everything below. |
| D2 | For the 39 drifted shared files, when apps have genuinely different logic (e.g. rider-panel's auth-guard supports legacy `delivery_agent` role, vendor-panel's supports multi-role `roles.vendor.status`), should the canonical shared version **support all app-specific variants via config/props** rather than picking one app's version as "correct" and discarding the others' logic? | **Yes** | Picking one blindly would regress real functionality another app depends on. Plan is to merge behavior, not overwrite it. |
| D3 | Delete `RazorpayButton.tsx` + `useRazorpay.ts` (8 files across 4 apps) — confirmed **zero call sites anywhere**, including in web-main where the real checkout path is `PaymentModal.tsx` → `lib/razorpay.ts` directly? | **Yes, delete** | Dead code, unused Razorpay-key-handling surface in 3 apps (admin/vendor/rider) that never need payments client-side at all. |
| D4 | `packages/firestore-rules/{firestore.rules,storage.rules}` is a **377-line-diverged stale copy** of the actually-deployed root `firestore.rules`/`storage.rules` (per `firebase.json`). Delete the stale package copy, or make the root files the generated output of the package (single source of truth)? | **Make `packages/firestore-rules` the single source of truth**, root files become symlinked/copied at deploy time | Two copies of security rules that can silently diverge is the highest-severity kind of drift possible. |
| D5 | Remove `firebase-admin` + `razorpay` npm deps and the unused `lib/firebaseAdmin.ts` from all 4 client apps (confirmed zero imports)? | **Yes** | Service-account-shaped code has no business in a static-exported browser bundle. |

If you want to skip straight to execution, say so and I'll proceed with all defaults above.

---

## 2. Issue inventory (concrete, file-referenced)

### 2.1 Critical — data model / logic drift

| File (relative to each app's `src/`) | Copies | Versions | What's different |
|---|---|---|---|
| `types/index.ts` | 4 | **4** | web-main/admin-panel carry pricing-override fields (`fluctuationMarginOverride`, `componentRatesOverride`, `rawKitchenCost`, `vendorMarginPercent`, `vendorPayout`, `algorithmicPricing`) that vendor-panel/rider-panel/gig's copies don't know about. If any app writes those fields to Firestore, apps reading the older type get silently-untyped data. |
| `lib/auth/auth-guard.tsx` | 4 | **4** | Each app's role check is genuinely different: web-main uses a flat `role` string + hardcoded superadmin email; admin-panel adds `isAdminUser()` from `auth-service`; vendor-panel adds multi-role `roles.vendor.status === 'verified'`; rider-panel adds legacy `delivery_agent` role name and restructures the render/redirect order entirely. None of this is wrong per se — it's just forked instead of parameterized, so a fix to the superadmin-bypass logic (say) has to be manually applied 4 times and already hasn't been. |
| `app/(auth)/login/page.tsx` | 4 | **4** | Per-app branding/copy, expected to differ, but currently forked at the full-file level with no shared skeleton. |
| `lib/queries/subscriptions.ts`, `users.ts`, `admin.ts`, `delivery.ts`, `vendorAdmin.ts`, `pricing.ts` | 4 each | 2–3 | Firestore query layer — the exact layer `AI_AGENTS_README.md` calls "the data access layer," forked and drifting per app. |
| `lib/razorpay.ts`, `hooks/useRazorpay.ts` | 4 each | 2 | See D3 — the hook path is dead everywhere; `lib/razorpay.ts` (used by `PaymentModal.tsx`) has drifted between a version with a `vendor_id` param and one with a cached-script-loader helper. |
| `firestore.rules` / `storage.rules` (root) vs `packages/firestore-rules/*` | 2 | 2 | 377-line diff. The package copy is missing the current admin-bypass fallback chain, the vendor/kitchen legacy-role fallback, and the entire `offers/{offerId}` storage path. **The package copy would be actively wrong if deployed.** |

### 2.2 High — dead code / unused surface

- `RazorpayButton.tsx` + `useRazorpay.ts` — 8 files, 4 apps, **zero call sites** anywhere (D3).
- `lib/firebaseAdmin.ts` + `firebase-admin`/`razorpay` deps — present in all 4 client apps' `package.json`, **zero imports** of `firebaseAdmin.ts` anywhere (D5).
- `apps/web-main/src/proxy.ts` and `apps/admin-panel/src/proxy.ts` — implement UA blocklist, body-size cap, and rate limiting, but both apps build with `output: 'export'` (confirmed in each `next.config.ts`), meaning **no Next.js server ever runs them in production.** `vendor-panel`/`rider-panel` don't even have a `proxy.ts` despite carrying the same `lib/server/rate-limit.ts` + `validate.ts` helper files. The real perimeter is the `razorpayApi` Cloud Function — that's where request-size/rate limits actually need to live, and per `functions/src/razorpayFunctions.ts` route dispatch, that's already partially true; needs a completeness check per route (`create-order`, `verify-payment`, `create-subscription`, `create-vendor-account`, `webhook`).
- `functions/lib/*` compiled output committed to the tree but stale relative to `functions/src/*` — should be `.gitignore`'d (it's a build artifact) once git is initialized.
- Root `app/` (2-file Next.js stub with default boilerplate title "Next.js") — not one of the 5 real apps, not referenced by `firebase.json` hosting, not linked from `package.json` `dev:*`/`build:*` scripts. Looks like leftover scaffold from before the monorepo split.

### 2.3 Medium — quality debt

- **web-main lint: 369 errors, 214 warnings.** Dominant patterns:
  - `no-explicit-any` ×311 — mostly Firestore doc casts (`data() as any`) and Razorpay window global casts. Fixable with typed Firestore converters + a proper `Window.Razorpay` ambient type.
  - `no-unused-vars` ×200 — dead imports/params, safe autofix candidate for most.
  - `set-state-in-effect` ×23, `exhaustive-deps` ×11, `purity` ×5, `immutability` ×5 — React-Compiler-era lint rules (Next 16 ships these); each needs a real look since they flag actual render-loop/stale-closure risk, not just style.
  - `no-unescaped-entities` ×19 — trivial JSX apostrophe/quote fixes.
  - admin-panel (522), vendor-panel (339), rider-panel (317) follow the same distribution (dominated by `no-explicit-any` and `no-unused-vars` from the same forked Firestore-query/type patterns — expect most of these to collapse automatically once Phase 1's typed converters replace the per-app `as any` casts). gig is materially cleaner (7 problems total, 3 source files, minimal forked logic).
- `functions/` has 4 Jest test files (`deliveryRedesign`, `deliveryTriggers`, `integration`, `pricingEngine`) covering only a slice of the 13 exported function groups — `matchingTriggers`, `swapFunctions`, `authTriggers`, `adminManagementTriggers`, `notificationTriggers`, `payoutTriggers`, `riderPaymentTriggers` have no tests today.
- `AI_AGENTS_README.md` (25 KB, the largest doc in the repo) documents a single-app `src/` tree that hasn't existed since the `apps/*` split — every path in it is wrong for an agent trying to follow it today.

### 2.4 Low — housekeeping

- `.env` in repo root has real secrets (`RAZORPAY_KEY_SECRET`, Firebase config). `.gitignore` already excludes `.env*`, but there's no `.env.example` to tell a new dev/agent what variables exist without exposing values.
- `scripts/` mixes one-off ops scripts (`approve-rider.mjs`, `bootstrap-admin.mjs`) with test scripts (`test-clean-address.mjs`, `test-geo.mjs`) with no README explaining which are safe to run against production data.

---

## 3. Phased plan

### Phase 0 — Safety net (½ day) — ✅ COMPLETE (2026-09-12)
- [x] **D1:** `git init`, gitignore hardened (added `.idea/`, `local.properties`, `build/`, `Pods/`, `.xcuserstate` etc. for android/ios), committed baseline as `9a04ece`.
- [x] `npm --prefix functions install` (529 packages), `tsc --noEmit` in `functions/` now clean — confirmed the prior errors were 100% missing-`node_modules`, not real type errors.
- [x] `npm audit fix` (non-breaking) on `functions/`: **22 → 13 vulnerabilities** (eliminated the 1 critical + all 6 high). Remaining 13 are moderate, all transitively pinned by `firebase-admin`'s dependency tree on an old `uuid`; a real fix needs a `firebase-admin` major bump — deferred, tracked below, not done silently.
- [x] `npm --prefix functions run test` — **47/47 tests pass, 3 suites.** A 4th file, `src/__tests__/integration.test.ts`, is excluded from the build by `tsconfig.test.json` and **cannot compile as written** — see finding below.
- [x] Root `npm run verify` added (`typecheck:apps` + `typecheck:functions` + `lint:apps` + `test:functions`), plus a `typecheck` script added to each of the 5 apps and to `functions/`.
- [x] `.env.example` (repo root) and `functions/.env.example` written — keys only, documents which vars are client-safe (`NEXT_PUBLIC_*`) vs. server-only.

**Done when:** `npm run verify` exists and its output is the tracked baseline; `git log` has commit 1; functions build and test. **✅ All met.**

#### 🔴 Critical finding surfaced during Phase 0 (not in the original plan — fixed immediately, ahead of schedule)

While verifying the Razorpay integration for Phase 2, found **three hardcoded live secrets** as fallback values in `functions/src/razorpayFunctions.ts`:
- `RAZORPAY_KEY_ID` fallback → a live (`rzp_live_...`) key id
- `RAZORPAY_KEY_SECRET` fallback → the paired API secret
- `RAZORPAY_WEBHOOK_SECRET` fallback → the webhook HMAC signature secret, additionally readable from a `NEXT_PUBLIC_*`-prefixed var name (which Next.js would have inlined into the browser bundle had anyone ever set it)

**Fixed:** all three `|| 'literal'` fallbacks removed; each now throws/`500`s loudly if the real env var is missing, instead of silently authenticating with a value anyone reading the source could see. Verified: `functions` typecheck clean, all 47 tests still pass.

**⚠️ Action needed from you, not something I can do:** rotate both the Razorpay API key secret and the webhook secret in the Razorpay dashboard — treat the old values as compromised regardless of whether this repo is ever pushed anywhere, since they were plaintext in source. **Also confirm before any functions deploy** that `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are actually set in the deployed Cloud Functions environment (`firebase functions:secrets:access RAZORPAY_KEY_SECRET` or the Firebase console) — I have no visibility into that from this checkout, and if they aren't set, this fix will make live payment/webhook requests start failing the moment it's deployed (right now they'd silently be authenticating with the leaked literal instead).

#### 🟠 Second finding: root `.env`/`.env.local` never reached any app's build

Next.js loads `.env`/`.env.local` from `process.cwd()`, not the monorepo root. Since every app under `apps/*` builds with its own directory as cwd, and no app had its own `.env` file, **the root env file was inert** — every env-driven value was silently falling back to a hardcoded literal baked into `lib/firebase.ts` (same anti-pattern as the Razorpay finding, lower severity since Firebase web config isn't secret, but it meant the `.agents/skills/task.md` claim "[x] Move Firebase config to env vars" wasn't actually true in practice).

**Fixed:**
- Added `scripts/sync-env.mjs` — copies root `.env`/`.env.local` into each `apps/*` directory (gitignored copies, never committed).
- Wired it into every app's `predev`/`prebuild` npm scripts and into `scripts/build-web.mjs` (the actual production build orchestrator, which calls `next build` directly and bypasses npm lifecycle hooks).
- Removed the hardcoded Firebase config fallback from all 4 client apps' `lib/firebase.ts`, replaced with a `requireEnv()` helper that fails loudly instead of silently using another project's config.
- **Verified end-to-end:** rebuilt all 5 apps from a clean sync — all succeeded, confirmed via build log (`Environments: .env.local, .env`) that real values are now flowing through, not the old hardcoded ones.

#### 🟡 Third finding: `functions/src/__tests__/integration.test.ts` is orphaned, not just untested

It imports `../../src/lib/queries/delivery`, `../../src/lib/queries/swaps`, `firebase/firestore` (the *client* SDK) — paths and APIs that belong to the web app's query layer (`apps/*/src/lib/queries/*.ts`), not to `functions/`. It cannot compile from where it sits (`functions/src/src/lib/...` doesn't exist) and `tsconfig.test.json` explicitly excludes it for exactly that reason. No app in the monorepo has Jest configured at all, so this file has no home anywhere today. Deferred to Phase 4 — flagged here rather than silently left excluded forever.

#### 🟡 Fourth finding: `eslint.config.mjs`'s `globalIgnores` didn't match per-app builds

Patterns like `.next/**`/`out/**` resolve relative to the *config file's* directory (repo root), not the invoking cwd — every app lints via `cd apps/<name> && eslint .`, so those patterns never matched `apps/<name>/out/**`. Invisible until a build actually exists in the tree; once one does, a plain lint run scans the entire minified build output as source (verified: inflated web-main from 369/215 to 1,944 errors / 24,104 warnings on identical code). **Fixed:** patterns now prefixed `**/` to match at any depth. This would have broken any CI pipeline that lints after building — caught here instead of in CI.

#### `npm run verify` redesigned mid-phase

First version chained steps with `&&`; since `lint:apps` currently always fails (1,142 known errors — that's expected and tracked, not a bug), the chain never reached `test:functions`. Replaced with `scripts/verify.mjs`, which runs all four steps unconditionally and prints a pass/fail summary, so "is anything broken" always gets a complete answer. Current real output:

```
✅ typecheck:apps
✅ typecheck:functions
❌ lint:apps      (1,142 known errors — tracked, Phase 3 scope)
✅ test:functions (47/47)
```

### Phase 1 — Canonicalize shared code — ✅ COMPLETE (2026-09-12)
Create/extend shared packages so there is exactly **one** definition of anything that must stay consistent across apps, while preserving each app's real behavioral differences as configuration, not forks.

- [x] New package `packages/shared-types` — merged the 4 `types/index.ts` variants into one canonical file. **Not** a naive "use the biggest file" merge: structurally diffed every union type and interface field set across all 5 apps and found `vendor-panel`'s `BatchStatus` had a real, load-bearing `'picked_up'` value none of the other 4 copies had (actual code keys a `Record<BatchStatus,...>` on it). Merged in, not dropped. All 5 apps now re-export from `@dabzzo/shared-types`; verified via typecheck (all 5 clean) and real builds (web-main, admin-panel, vendor-panel). See CHANGELOG.md for the full divergence analysis.
- [x] `packages/shared-auth`: `auth-guard.tsx` rewritten (was actually a dead no-op stub — rendered children unconditionally, never wired up). Consolidated all 4 apps' extended-role-membership rules (admin `superadmin`/`roles.admin`, vendor `roles.vendor.status`, rider `delivery_agent`/`roles.delivery`) into one function applied uniformly to every role in `allowedRoles`, not just each app's "home" role — found and fixed a real access gap in the process (a `role: 'superadmin'` user could reach admin-panel but not vendor-panel/rider-panel despite both listing `'admin'` in `allowedRoles`). Each app keeps a thin wrapper for its own store hook + loading-screen copy. Verified: typecheck clean × 5, full builds × 4 (web-main, admin-panel, vendor-panel, rider-panel).
- [x] Consolidated the whole 18-module Firestore query layer into `@dabzzo/shared-queries`, reconciled function-by-function. Canonical choice was decided by *which copy actually runs* — `getVendorStats`/`forceFormBatches` are called only by admin-panel, and three apps carried never-executed variants. `users.ts` cache TTLs were a genuine conflict (5 min vs rider-panel's 20 s) and are now configurable rather than arbitrated.
- [x] Moved 37 identical components into `@dabzzo/shared-ui`, all 5 Zustand stores and 10 lib modules into `@dabzzo/shared-lib`, Firebase init + auth-service + AuthProvider into `@dabzzo/shared-auth`. `Logo` differed only in branding and is now parameterized.
- [x] Removed **11,671 lines of dead code** — a reachability scan showed nearly every remaining "drifted duplicate" was simply never imported by the apps carrying it.
- [x] **D3:** Delete `RazorpayButton.tsx` + `useRazorpay.ts` from all 4 apps. Re-confirmed zero call sites immediately before deleting; verified via typecheck + build.
- [x] **D5:** Remove `lib/firebaseAdmin.ts` + `firebase-admin`/`razorpay` from all 4 client `package.json`s. Root `package.json` keeps `firebase-admin` (7 root-level ops scripts under `scripts/` genuinely need it) but drops `razorpay` (unused at root). Root workspace `npm audit`: 30 → 11 vulnerabilities via non-breaking fix; remaining 11 all trace to the pinned `next@16.2.6` — tracked as a dedicated task below, not force-upgraded mid-refactor.
- [ ] Delete the root `app/` stub (§2.2) after confirming with you it's not a deploy target (it isn't referenced anywhere).
- [ ] **New, found during Phase 1:** bump `next` off `16.2.6` — 1 critical + 2 high `npm audit` findings (middleware/proxy bypass, DoS via Server Actions, SSRF via rewrites/Server Actions, cache confusion) all trace to the pinned Next.js version, vulnerable range extends to 16.3.2. Needs its own isolated test pass across all 5 apps (build + smoke test each) before landing — exact-pinned everywhere, not a drop-in bump.

**Done when:** `types/index.ts`, `auth-guard.tsx`, and the query layer exist in exactly one place each; `tsc --noEmit` still passes on all 5 apps; app-specific behavior still works, now as explicit config. **✅ All met.** Net ~46,000 lines removed across 7 commits, each verified with typecheck on all 5 apps plus a real static-export build of all 5.

#### 🔶 New decisions raised during Phase 1 (need your call — nothing changed unilaterally)

| # | Decision | Why it matters |
|---|---|---|
| **D6** | **Gate the superadmin test-seeding to non-production.** On sign-in, `vendor-panel` writes a "Test Vendor" profile to Firestore with `verification_status: 'verified'`, a sample FSSAI licence number (`FSSAI-12345678901234`), sample rates and a 4.5★/14-review history. `rider-panel` does the same as a verified rider. This runs in **production** builds. Behaviour is preserved exactly as-is for now. | Fabricated compliance data (a food-safety licence number) and a fabricated rating history in the live `users` collection. Also means the superadmin account can't be used to test the *unverified* onboarding path, because it self-verifies. |
| **D7** | **Admin UI ships in the public customer bundle.** `web-main` (dabzo.web.app / dabzzo.in) contains `/admin/dashboard`, `/admin/users` and `UserManagementHub` (~2,100 lines), and its login routes admins there. It's wired up and reachable, so it isn't dead code — but the admin console already exists as its own deployed app. | Any customer downloads the admin UI. Firestore rules still gate the *data*, so this is bundle-size and attack-surface, not an authz hole. Removing it would break admin login through the customer app, so it's a product call. |
| **D8** | **Bump `next` off 16.2.6.** 1 critical + 2 high `npm audit` findings (middleware/proxy bypass, DoS via Server Actions, SSRF via rewrites, cache confusion) all trace to the pinned version; the vulnerable range extends to 16.3.2. | Needs its own isolated pass: `next` is exact-pinned across all 5 apps and all 5 depend on static-export behaviour. Not folded into refactor commits. |

### Phase 2 — Security & rules consolidation (1 day)
- [ ] **D4:** Make `packages/firestore-rules/{firestore.rules,storage.rules}` the source of truth; regenerate the root copies from it (script or symlink) so `firebase.json`'s deploy target and the package can never diverge again.
- [ ] Audit `functions/src/razorpayFunctions.ts` route-by-route (`create-order`, `verify-payment`, `create-subscription`, `create-vendor-account`, `webhook`) for auth check + input validation + idempotency, since this is the actual perimeter now that client-side `proxy.ts` is confirmed non-functional under static export.
- [ ] Decide fate of `proxy.ts`/`lib/server/{rate-limit,validate}.ts`: either delete (if the Cloud Functions layer is judged sufficient) or document explicitly in each app's README that they are inert under static export and why they're kept (e.g., for a future non-static deploy mode).
- [ ] Re-run the full `.agents/skills/task.md` checklist once against the *current* code to confirm nothing regressed silently while it sat unverified.

**Done when:** one rules source of truth exists; every `razorpayApi` route has a documented auth/validation/idempotency story; `proxy.ts` fate is decided and documented, not just left ambiguous.

### Phase 3 — Lint & correctness cleanup (2 days, scales with final numbers)
- [ ] Run `eslint --fix` where safe (unused-vars, unescaped-entities) across all 5 apps; hand-fix the rest.
- [ ] Replace `data() as any` Firestore casts with typed converters (`withConverter<T>()`) using the now-canonical types from Phase 1 — this alone should collapse most of the 311 `no-explicit-any` hits in web-main and its counterparts.
- [ ] Add an ambient `Window.Razorpay` type instead of `(window as any).Razorpay` casts. *(The ambient type now exists canonically in `packages/shared-types`; the conflicting per-app `declare global` duplicates were removed 2026-09-15 — see CHANGELOG. Remaining work is converting the `(window as any)` call-sites to the shared `RazorpayConstructor` type.)*
- [ ] Triage every `set-state-in-effect` / `exhaustive-deps` / `purity` / `immutability` hit individually — these are React-Compiler-era rules flagging real render-loop or stale-closure risk in a 19-app... sorry, 5-app codebase running React 19 + Next 16; not stylistic.
- [ ] Fold final admin-panel/vendor-panel/rider-panel/gig lint numbers into this checklist once the background run (kicked off during this planning session) completes.

**Done when:** `npm run verify` is lint-clean (0 errors) across every workspace; warnings triaged and either fixed or explicitly suppressed with a comment explaining why.

### Phase 4 — Test coverage for core business logic (1–2 days)
- [ ] Add Jest coverage for the untested function groups: `matchingTriggers` (2 km proximity dispatch + radius widening), `swapFunctions` (swap-request state machine), `authTriggers` (self-promotion prevention — already fixed per task.md, needs a regression test so it can't silently regress), `payoutTriggers`/`riderPaymentTriggers` (distance × rate + volume bonus math).
- [ ] Confirm `npm --prefix functions run test` runs cleanly in CI-equivalent conditions (fresh install, no local state).

**Done when:** every exported Cloud Function group in `functions/src/index.ts` has at least one test exercising its core path.

### Phase 5 — Documentation (½ day, can run in parallel with any phase above)
- [ ] Rewrite `AI_AGENTS_README.md` to reflect the real `apps/*` + `packages/*` monorepo layout — every path in the current version is stale.
- [ ] Add a `README.md` to each new/changed shared package (`shared-types`, `shared-auth`, `shared-ui`, `firestore-rules`) explaining what's canonical there and why apps must not fork it again.
- [ ] Add `scripts/README.md` labeling each script safe/destructive and what it touches (production Firestore vs. local emulator).
- [ ] Maintain [CHANGELOG.md](CHANGELOG.md) — one entry per phase, listing exact files added/changed/removed. (Stub created alongside this plan; first real entry lands with Phase 0.)

**Done when:** a fresh agent or developer can onboard from `README.md` → `AI_AGENTS_README.md` and find every path they read about.

### Phase 6 — Deployment readiness (1 day)
- [ ] `node scripts/build-web.mjs` (all 5 apps) — confirm every `apps/*/out` directory builds clean with the Phase 1–3 changes in place.
- [ ] Confirm `.firebaserc` targets match `firebase.json` hosting blocks (5 targets: web-main, vendor-panel, rider-panel, admin-panel, gig).
- [ ] `npx firebase deploy --only firestore:rules --dry-run`-equivalent check (emulator) after Phase 2's rules consolidation.
- [ ] `npm --prefix functions run build` + confirm secrets (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, webhook secret) are configured via Firebase Functions config/secrets, not baked into source.
- [ ] Capacitor/Android: confirm `npx cap sync` runs clean against the rebuilt `web-main/out`; check `android/` version code bump policy before any store submission.
- [ ] Write a one-page `DEPLOYMENT.md`: exact command sequence for a full release (build → rules → functions → hosting → mobile sync), plus rollback steps (`firebase hosting:clone` to a previous release, functions redeploy of previous git tag).

**Done when:** a single documented command sequence takes the repo from `main` to all 5 hosting targets + functions + mobile sync, with a rollback path.

---

## 4. What changes / what gets added — manifest

This is the concrete "what are we touching" list, kept in sync as phases execute:

**New:**
- `packages/shared-types/` (or extension of `shared-auth`)
- `packages/shared-firestore/` (query layer)
- `.env.example`
- `CHANGELOG.md`
- `DEPLOYMENT.md`
- `scripts/README.md`
- README per shared package

**Modified:**
- All 4 client apps' `package.json` (remove `firebase-admin`, `razorpay` deps)
- `types/index.ts`, `lib/auth/auth-guard.tsx`, `lib/queries/*.ts` in all 4 apps → become thin re-exports of shared packages
- `AI_AGENTS_README.md` (full rewrite)
- `packages/firestore-rules/{firestore.rules,storage.rules}` (becomes canonical; root files regenerated from it)
- `functions/src/razorpayFunctions.ts` (validation/idempotency audit fixes, if any found)
- `.gitignore` (verify `functions/lib/` etc. are covered post-git-init)

**Removed:**
- `RazorpayButton.tsx` + `useRazorpay.ts` × 4 apps (8 files)
- `lib/firebaseAdmin.ts` × 4 apps
- Root `app/` stub (pending your confirmation)
- Duplicate copies of the 78 identical + 39 reconciled files, once re-pointed at shared packages

---

## 5. Sequencing & effort

| Phase | Effort | Depends on |
|---|---|---|
| 0 — Safety net | 0.5 day | — |
| 1 — Canonicalize shared code | 2–3 days | 0 |
| 2 — Security & rules | 1 day | 1 (types needed for query layer changes) |
| 3 — Lint cleanup | 2 days | 1 (typed converters need canonical types) |
| 4 — Test coverage | 1–2 days | 0 (functions installed) |
| 5 — Documentation | 0.5 day | can run parallel throughout |
| 6 — Deployment readiness | 1 day | 1, 2, 3 |

**Total: ~8–10 working days** for one engineer/agent working sequentially; phases 3–5 can overlap with 2 if split across more than one contributor.

---

## 6. Next step

Tell me to proceed and I'll start Phase 0 immediately (git init + baseline commit, install `functions/` deps, run the real test baseline, add `npm run verify`) — or flag any of the D1–D5 decisions above you want to change first.
