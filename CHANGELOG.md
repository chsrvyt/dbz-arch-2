# Changelog

Tracks every change made under [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), one entry per phase. Newest first.

Format per entry: date, phase, files added/changed/removed, and the reason — enough for someone who wasn't in the room to understand what happened and why without re-deriving it.

---

## 2026-09-22 — Phase 26: product hardening — delivery-transition integrity, one order lifecycle, vendor/rider ops drill-down

Post-plan product run continuing from 2026-09-21. This pass hardened the delivery lifecycle end to end: the rider callable can no longer set arbitrary statuses, the Track page and order lists agree with one shared status model, the expiry sweep is auditable, the vendor gets a real order drill-down, and the rider IDLE queue is sorted and labelled.

### 1. P0 — `updateDeliveryStatus` target whitelist

`functions/src/deliveryTriggers.ts`: the rider callable previously validated *transitions* only when the requested status matched one of four guards — any OTHER value (including canonical-but-wrong statuses like `cancelled`, `ready`, arbitrary garbage) fell straight through to a blind Firestore `update` with that status. Verified possible: `DELIVERED → ASSIGNED`/`PREPARING` etc. Now the four rider-legitimate statuses (`picked_up`, `out_for_delivery`, `delivered`, `failed_attempt`) are whitelisted up front and anything else throws `invalid-argument` before any read/write. (The `picked_up` guard keeps its `pending`/`created` prestates — the direct "mark picked up" flow relies on it.) `verifyDeliveryOTP` remains the OTP-gated path to `delivered`.

### 2. Single order-lifecycle source of truth

New `packages/shared-lib/src/orderLifecycle.ts` (`./orderLifecycle` export) — the canonical 20-status vocabulary, plus sets and helpers every panel was hand-rolling differently:

- `LIVE_TRACKING_STATUSES` — includes every pre-dispatch stage (`created`, `pending`, `vendor_notified`, `vendor_preparing`, `cooking`, `vendor_ready`, `ready`, `dispatched`, `rider_assigned`, `rider_en_route_pickup`, `picked_up`, `out_for_delivery`, plus defensive `preparing`/`picking_up`).
- `DELIVERED_STATUSES`, `INACTIVE_STATUSES`, `ACTIVE_ORDER_STATUSES`, `ORDER_STATUS_LABELS`, `statusToLifecycleStage()` (maps every status onto the 5-step customer timeline), `isLiveStatus`, `isDeliveredStatus`, `isInactiveStatus`.

**Customers (web-main):** `track/page.tsx` + `orders/page.tsx` stopped carrying their own live-status lists. The Track page previously skipped `created`/`ready` etc. → a real today-dated order rendered **"No Active Delivery"**; now any non-terminal today order draws the live timeline. Also fixed a second Track bug: a failing orders/subscriptions/direct-order listener left `loading=true` forever (permanent spinner) because only the *next* callback cleared it — error callbacks now drop through to `setLoading(false)` / last-known data. `RiderTrackingCard.tsx` maps every canonical status onto its 5 steps via the shared helper (no more raw-status pills for unknown statuses) and gained per-status cycling messages.

### 3. Auditable expiry sweep

New `functions/src/auditUtils.ts` — `writeAuditLog()` appends to `audit_logs` writing both snake_case (server/legacy) and camelCase (client) keys with server timestamps. `expireSubscriptions` now records one `subscription.expiry.sweep` entry per run (expired count, affected user ids, `sweepRunId`) and a `subscription.expiry.user_clear` entry for every user whose entitlement flags were wiped — so audit_logs finally covers automated system mutations, not just admin callables.

### 4. Vendor panel — real order drill-down

`packages/shared-queries/src/delivery.ts` gained `getVendorPrepDetails(vendorId, date)` returning the underlying order rows (customer, meal, status, address, rider, box tag, created-at), reusing the `vendor_id + date` composite query. `apps/vendor-panel/.../dashboard/page.tsx`: the prep-breakdown card now has a **View Orders** button → bottom-sheet modal listing today's tiffins sorted newest-first with status chips, call buttons and rider info, plus an amber "cancelled/skipped need attention" line. Removed six dead icon imports (`Sliders`, `RefreshCw`, `ShieldCheck`, `Clock`, `ArrowUpRight` — lint now clean for that file).

### 5. Rider panel — ordered, labelled queue

`apps/rider-panel/.../dashboard/page.tsx`: the IDLE "Your Assigned Deliveries" queue is now sorted (in-flight by stage first, terminal pushed last), the first remaining stop gets a **NEXT** badge + brand highlight, the header shows `N to go / M done / failed`, and every icon-only control (queue call/map, kitchen call/navigate, drop navigation, profile photo, logout) gained `aria-label`s next to its existing `title`.

### 6. Tests

`functions/src/__tests__/deliveryTriggers.test.ts`: +3 tests pinning the whitelist (`cancelled`, `rider_assigned`, `ready` all rejected with `Cannot set delivery status to …`). New `functions/src/__tests__/auditUtils.test.ts` (2 tests): full audit payload shape (snake+camel keys, merge, timestamps) and nulled optional fields. **152/152 functions tests pass** (was 147); all apps + packages typecheck; lint 0 errors.

### Files

- Changed: `functions/src/deliveryTriggers.ts`, `functions/src/subscriptionExpiry.ts`, `packages/shared-lib/package.json`, `packages/shared-queries/src/delivery.ts`, `apps/web-main/src/app/(user)/track/page.tsx`, `apps/web-main/src/app/(user)/orders/page.tsx`, `apps/web-main/src/components/delivery/RiderTrackingCard.tsx`, `apps/vendor-panel/src/app/dashboard/page.tsx`, `apps/rider-panel/src/app/dashboard/page.tsx`, `functions/src/__tests__/deliveryTriggers.test.ts`
- Added: `packages/shared-lib/src/orderLifecycle.ts`, `functions/src/auditUtils.ts`, `functions/src/__tests__/auditUtils.test.ts`
- No removals.

Post-plan product run (not part of the Phase 0–6 plan). One coherent logical fix carried across server, shared client library, and every panel, plus the assigned-delivery rider view, a real vendor "today's preparation" tiffin count, and cross-tenant read-rule closure.

### 1. The bug: an expired subscription kept functioning

`next_billing_date` was written at subscription creation, but nothing anywhere compared `now` against it at runtime. Every UI (dashboard, orders, track, vendor, storefront), every callable, and the order-generation triggers all keyed off `status === 'active'` only — so a subscription whose billing date had passed months ago still worked forever.

**Fix — entitlement becomes a computed invariant (single source of truth):**

- `functions/src/subscriptionExpiry.ts` — `getSubscriptionExpiryMs()` (aliases: `next_billing_date`, `nextBillingDate`, `end_date`, `valid_until`; accepts Timestamp / `{_seconds}` / Date / ISO string / epoch ms), `isSubscriptionActive()`, `isSubscriptionExpired()` (`now >= next_billing_date` → expired; **exactly-at is expired**; missing end date → not expired as a legacy safety), `getSubscriptionAccessRecord(db, subId)`, and `expireSubscriptions` — an hourly IST scheduler (`'30 * * * *'`, `Asia/Kolkata`) that paginates subscriptions, flips status → `cancelled` with `cancelled_by: 'system_expiry'`, and clears the user's `has_active_subscription` / `subscription_id` flags. Registered in `index.ts`.
- `functions/src/deliveryTriggers.ts` — `onSubscriptionCancelled` now cascades any non-terminal future order (statuses `created`, `pending`, `preparing`, `vendor_notified`, `vendor_preparing`, `vendor_ready`, `rider_assigned`, `rider_en_route_pickup`, `ready`, `cooking`, `dispatched`) to cancelled. In-flight `picked_up` / `out_for_delivery` orders are left to finish; terminal statuses untouched. This is the single cancel path — the sweep flips the subscription, the trigger cascades the orders.
- Callables guarded on live entitlement (`failed-precondition` when inactive): `skipMealOrder`, `undoSkipMealOrder` (`deliveryTriggers.ts`, v2 HttpsError), `requestMealSwap` (`swapFunctions.ts`, v1) — a MEAL SWAP on an expired subscription now fails instead of silently rescheduling another customer's meal.
- `packages/shared-lib/src/subscriptionEntitlement.ts` **new** + `./subscriptionEntitlement` export — client mirror of `getSubscriptionExpiryMs` / `isSubscriptionActive` / `isSubscriptionExpired` / `getSubscriptionAccess` / `getCustomerAccessState`, so every app computes the SAME answer the server does, offline.
- `packages/shared-queries/src/subscriptions.ts` — adds `getActiveSubscriptionsFor(userId)` and `getCustomerEntitlement(userId)`; `getVendorSubscriptions` now entitlement-filters.

**UI wiring (web-main):** dashboard (delivery card gated on active sub; orders listener date-filtered to today), orders (Track banner + new amber RENEW banner when any sub needs renewal → `/track`; inline map gated), track (`renderRenewBanner` → `/profile` in both the empty state and the main header), profile (new "Expired Subscriptions" section with Renew buttons opening the PaymentModal), rewards + vendor detail counts, and `SubscriptionManager` / `SubscriptionOnboardingModal` / `MonthlyCustomPlanBuilder` all filter by entitlement rather than raw status.

### 2. Rider panel: assigned deliveries surfaced

The IDLE branch was a blank "no active trip" canvas while the squadded drop-stops list was hidden behind an already-started trip. Now: per-stop `DeliveryCard`s gain an order chip `#<order-id-last-8>`, the current drop header shows the full order id, and IDLE renders a "Your Assigned Deliveries" queue — customer, address, order/meal, status chip, `tel:` call link, and a Google Maps deep link. (`apps/rider-panel/src/app/dashboard/page.tsx`)

### 3. Vendor panel: "Today's Preparation" from real orders

Replaced the static metric with `getVendorPrepSummary(vendorId, date)` + `summarizeOrders` in `packages/shared-queries/src/delivery.ts` — a composite `vendor_id + date` query (camelCase fallback for legacy docs) counting needs-prep tiffins (non-terminal), lunch/dinner split (`meal_type 'both'` counts +1 lunch +1 dinner), dispatched/delivered/cancelled, and a per-status breakdown. New composite index `orders(vendor_id, date)` added to `packages/firestore-rules/firestore.indexes.json`. Dashboard polls every 60 s and shows "Today's Preparation" + a live per-status chips strip.

### 4. Rules hardening (cross-tenant reads closed)

`orders` list/get previously granted **every verified rider/vendor read access to the entire orders collection** (all customers' names, addresses and OTPs); `subscriptions.list` allowed **any authenticated user** to list all subscriptions; `deliveries.list` had the same blanket role gates. All three now require the doc to name the caller as a participant (`resource.data` field match) or admin. (`packages/firestore-rules/firestore.rules`)

### 5. Tests

- `functions/src/__tests__/subscriptionExpiry.test.ts` **new**: expiry-boundary pinning (before / exactly-at → expired / after; legacy no-end-date; field aliases; status guard) + `getSubscriptionAccessRecord` with a mocked db.
- `functions/src/__tests__/swapFunctions.test.ts` — updated the firebase-admin mock to give `subscriptions` its own (valid, active) doc so the entitlement guard is exercised rather than blasting every swap case.
- `packages/firestore-rules/rules.test.mjs` — 8 new cases: order get own/other, rider scoped get, unscoped rider orders scan denied, rider deliveries list (scoped succeed, bare scan denied), customer deliveries, vendor subscriptions (own-only list, bare scan + get-other denied). All 34 pass against the emulator.

**Verified:** `npm run verify` — typecheck (apps + packages) ✅, typecheck:functions ✅, lint (apps + packages) ✅, functions tests 147/147 ✅; `npm run test:rules` 34/34 ✅.

### Files

| Area | Files |
|---|---|
| Functions | `functions/src/subscriptionExpiry.ts`, `functions/src/deliveryTriggers.ts`, `functions/src/swapFunctions.ts`, `functions/src/index.ts`, `functions/src/__tests__/subscriptionExpiry.test.ts` (new), `functions/src/__tests__/swapFunctions.test.ts` |
| Shared | `packages/shared-lib/src/subscriptionEntitlement.ts` (new), `packages/shared-lib/package.json`, `packages/shared-queries/src/subscriptions.ts`, `packages/shared-queries/src/delivery.ts` |
| Rules | `packages/firestore-rules/firestore.rules`, `packages/firestore-rules/firestore.indexes.json`, `packages/firestore-rules/rules.test.mjs` |
| web-main | `apps/web-main/src/app/(user)/{dashboard,orders,track,profile,rewards}/page.tsx`, `apps/web-main/src/app/(user)/vendor/detail/page.tsx`, `apps/web-main/src/components/subscription/{SubscriptionManager,SubscriptionOnboardingModal,MonthlyCustomPlanBuilder}.tsx` |
| vendor-panel | `apps/vendor-panel/src/app/dashboard/page.tsx` |
| rider-panel | `apps/rider-panel/src/app/dashboard/page.tsx` |

---

## 2026-09-15 — web-main Track Meal page overhaul + repo-wide Razorpay build blocker fixed

Post-plan work (adds to the completed Phase 1–6 status, not part of any phase). Two independent work streams in one session:

### 1. Customer app (web-main): Track Meal page overhaul + Rewards nav removal

Goal: make the Track page reflect delivery reality — a real DELIVERED state, an explicit FAILED state, less noise for the common case — without touching the backend status flow or the platform's visual identity.

**Files:**

| File | Change |
|---|---|
| `apps/web-main/src/components/layout/UserNav.tsx` | Removed the Rewards icon + nav item from `NAV_ITEMS` (covers both the bottom-tab and sidebar variants). `/rewards` route and `RewardsModal` untouched — Rewards is still reachable from the Profile page. |
| `apps/web-main/src/components/delivery/DeliveryCompleteCard.tsx` | **New.** Compact delivered-order summary: green "DELIVERED" hero, meal name, kitchen, delivered date/time, delivery address, "View Orders" link to `/orders`. |
| `apps/web-main/src/components/delivery/RiderTrackingCard.tsx` | Added `scheduledSlot?: string` prop so the ETA hero shows the real slot (8:00 AM / 11:00 AM / 8:00 PM) instead of hardcoded 1:00 PM/8:00 PM by meal type. Extended `showMap` to `rider_assigned`/`picked_up` (was `out_for_delivery`/`delivered` only) — the live Leaflet map now appears whenever GPS is available. Removed the dead "Map unlocks when rider picks up" placeholder and the misleading no-op "Tap to rate your experience" ⭐ row. |
| `apps/web-main/src/app/(user)/track/page.tsx` | See "Track page rewrite" below. |

**Track page rewrite** (bulk of the session):

- **DELIVERED → `DeliveryCompleteCard`.** A `delivered` order now renders the new summary card instead of the full live-tracking card (whose countdown / ETA / OTP reveal UI is meaningless post-delivery).
- **Duplicate map removed.** The page previously mounted TWO maps — a Google-Maps `LiveDeliveryMap` at top AND a Leaflet map inside `RiderTrackingCard`. Removed the dead Google duplicate.
- **FAILED → compact "NOT DELIVERED" card.** Failed orders get a rose/red card (reason-aware copy for `customer_unavailable`) with a "Contact Support" link to `/support`, replacing a card indistinguishable from a live delivery.
- **`resolveDeliveredAt()` helper** normalizes the delivered timestamp across every shape the writers produce: `timestamps.deliveredAt` (canonical data model), `delivered_at` (top-level, written by `functions/src/deliveryTriggers.ts` on `verifyDeliveryOTP` / `updateDeliveryStatus`), and `deliveredAt` (legacy camelCase).
- **Notifications collapsed behind an "Updates" toggle** (progressive disclosure) that auto-expands on a `delay_alert`.
- **Header simplified** to a single status pill + meal name + one subtitle line; the next-order card dropped its redundant Scheduled/Status grid.
- **Dead code removed:** unused date-string local vars (`todayStr`, `tomorrowStr`, `dayAfterStr`, dead `now`/`start`) and a shadowed dead `qOrders` query; re-added the missing `Link` import (the failed state's support link compiled only because `useSearchParams` happened to be imported from `next/navigation` — `Link` itself was not).
- Superadmin inspector mode unchanged, still renders above everything.

**Judgement calls, made explicitly:**

- `DeliveryCompleteCard` and the page helpers type order data as `any`, consistent with the entire page/app. The order documents are legacy-mapped (snake_case + camelCase + nested `timestamps`), and the canonical `DeliveryOrder` type does not cover the union of shapes read here — full typing would need a normalization layer, out of scope.
- Rewards removed from **navigation only**; profile modal + functionality preserved.

**Verified:** `tsc --noEmit` clean on web-main; lint on the touched files went **40 problems → 36** (warnings 8 → 2; +3 `no-explicit-any` from the new helpers, matching file-wide style); full static-export build of all 5 apps passes.

### 2. Repo-wide: pre-existing Razorpay `Window` declaration conflict (build blocker)

`npm run build:web` and `tsc --noEmit` were failing in **all** apps with `TS2687`/`TS2717`:

```
All declarations of 'Razorpay' must have identical modifiers.
./src/hooks/useRazorpay.ts:17:5
```

**Cause:** every app's `src/hooks/useRazorpay.ts` carried its own non-optional `declare global { interface Window { Razorpay: new (options: RazorpayOptions) => RazorpayInstance; } }` (byte-identical ×4), colliding with the canonical optional declaration in `packages/shared-types/src/index.ts` (`Window.Razorpay?: RazorpayConstructor`). Two global augmentations of the same property with different types are a hard TS error.

**Fix:** the shared-types declaration is canonical; the per-app duplicates were redundant and removed from all 4 apps. `web-main` already accessed the SDK via `(window as any).Razorpay` (safe). `admin-panel`, `vendor-panel`, and `rider-panel` called `new window.Razorpay({...})` unguarded — the shared declaration makes the property optional, so a null guard was added that rejects with "Razorpay SDK failed to load." before constructing. No behaviour change when the SDK loads normally.

**Files:** `apps/{web-main,admin-panel,vendor-panel,rider-panel}/src/hooks/useRazorpay.ts` — modified.

**Verified:** web-main typecheck 0 errors; `npm run build:web` ✅ all 5 apps; `npm run test:functions` ✅ 99/99.

### Hygiene note (not this session's source changes)

`git status` also shows modified **`functions/lib/*.js`** (compiled Cloud Functions output, git-tracked, regenerated whenever the functions build/test runs) and **`apps/{gig,vendor-panel}/.next/*`** (static-export artifacts) — build-output churn only. IMPLEMENTATION_PLAN.md §2.2 already flags that `functions/lib/` should be `.gitignore`'d; that decision is still open.

---

## 2026-09-12 — Correction: the delivery_address impact claim was overstated

The previous entry said the `delivery_address` type mismatch meant the 2 km swap-candidate search "silently matches nobody". **That overstated it, and the correction matters before anyone migrates data.**

Tracing every writer:

| Writer | Collection | Shape |
|---|---|---|
| `functions/src/deliveryTriggers.ts:397, :1217` | **`orders`** | object `{ line1, lat, lng }` ✅ |
| `packages/shared-queries/src/subscriptions.ts:575` | `subscriptions` | bare string |
| `functions/src/pricingFunctionsLegacy.ts:260` | `subscriptions` | bare string (and not exported from `functions/src/index.ts`, so not even deployed) |

Both string-form writes target **`subscriptions`**, not `orders`. Every path that writes an *order* uses the object form. The swap search reads `orders`. So through current code there is no order with a string `delivery_address`, and the failure I described does not occur.

What stands from that commit: `delivery_address` really is polymorphic *across the database* (string on subscriptions, object on orders), so typing it as a union and routing reads through `addressCoords()` is still correct and still the defensive thing to do. Only the impact claim was wrong.

**What this does not rule out:** orders predating the canonical schema. Static analysis describes code, not the documents actually sitting in Firestore. Hence two new scripts rather than a blind migration:

- `scripts/audit-delivery-address.mjs` — **read-only**. Reports the distribution of `delivery_address` shapes across `orders`, and for anything lacking coordinates, whether they could be recovered from the order's own `address` field or the customer's saved `location`.
- `scripts/fix-delivery-address.mjs` — **dry run unless `--apply`**. Backfills coordinates from those two sources, preserves the previous value in `delivery_address_original` so it is reversible, and refuses to invent a location for orders where none can be found, reporting them instead.

Run the audit first. If it reports zero, there is nothing to fix and the fix script should not be run at all.

---

## 2026-09-12 — Phase 1 complete: shared packages, −46,000 lines

Five shared packages now hold everything that must stay consistent across the five apps. Net effect across parts 1–7: **~46,000 lines removed**, with every step verified by typecheck on all 5 apps plus a real static-export build of all 5.

| Package | Holds |
|---|---|
| `@dabzzo/shared-types` | `AppUser`, `Subscription`, `Order`, `Batch`, delivery + payout types |
| `@dabzzo/shared-auth` | Firebase client init, auth-service, AuthGuard, AuthProvider |
| `@dabzzo/shared-lib` | pricing, geo, storage, haptics, notifications, offline queue, all 5 Zustand stores |
| `@dabzzo/shared-queries` | the 18-module Firestore data-access layer |
| `@dabzzo/shared-ui` | 37 shared components incl. a parameterized `Logo` |

### Real bugs found by reconciling the forks

These were not cleanliness problems — each was a live inconsistency between apps:

1. **Weekly pricing mismatch.** `admin-panel`'s `pricing.ts` lacked the weekly-plan formula that `web-main` *and* the server-side `functions/src/pricingEngine.ts` implement. Verified against the server (the actual charging authority): admin computed weekly prices ~₹0.40/meal below what customers are charged.
2. **Cross-portal access gap.** Each app's `auth-guard` applied only its *own* extended-role rule. `vendor-panel` and `rider-panel` both gate with `allowedRoles={[…, 'admin']}`, but neither understood `role === 'superadmin'` — so such a user could reach admin-panel and nowhere else. Now every rule applies to every role named in `allowedRoles`.
3. **`BatchStatus` missing a state.** `vendor-panel`'s copy uniquely had `'picked_up'`, which its own dashboard keys a `Record<BatchStatus, …>` on. The other four copies lacked it.
4. **Unhardened image URLs.** `vendor-panel`'s `getImageUrl` lacked the null-safety and the guard stopping localhost/emulator URLs rendering on production domains.
5. **Build script reported success on failure.** `scripts/build-web.mjs` printed "🎉 completed successfully" even when an app's build failed (it set `exitCode` but printed the banner unconditionally). An intermediate build during this work failed for rider-panel and still ended green. Also fixed: an unknown app name exited 0.
6. **`export *` drops default exports.** Four components are loaded via `next/dynamic()`, which needs the default. Caught by typecheck before shipping.

### Judgement calls, made explicitly

- **Which copy is canonical** was usually decided by *which one actually runs*, not which looked newer. `getVendorStats` and `forceFormBatches` are called only by admin-panel; three apps carried different, never-executed versions. Adopting the more elaborate `getVendorStats` because it "looked better" would have silently changed live vendor financial reporting.
- **Cache TTLs in `users.ts`** were a genuine conflict with no right answer: 5 minutes in three apps, 20 seconds in rider-panel (riders read this mid-delivery). Rather than pick, TTLs are configurable with the 5-minute default; rider-panel opts in via `configureUserCacheTTLs()` in `RiderAppShell.tsx`.

### 11,671 lines of dead code removed

A reachability scan showed nearly every remaining "drifted duplicate" was simply dead: when four apps were bootstrapped by copying one into three, every app got every component, but each is imported by exactly one. `AdminNav` only by admin-panel, `PaymentModal` only by web-main, `TodayMenuCard` only by vendor-panel, and so on.

Two false-positive classes were corrected before anything was deleted: a static-import-only scan wrongly marked `RiderTrackingCard` dead (it is loaded via `next/dynamic()` in web-main), and substring matching flagged `DeliveryNav` because of `useDeliveryNavigation`.

Source files per app afterwards: web-main 99, admin-panel 76, vendor-panel 60, rider-panel 47, gig 2.

---

## 2026-09-12 — Phase 1 (continued): shared AuthGuard

Consolidated the 4 drifted `auth-guard.tsx` copies (web-main, admin-panel, vendor-panel, rider-panel — `gig` never had one) into `packages/shared-auth/src/auth-guard.tsx`, replacing what was actually a dead no-op stub there before (the pre-existing `AuthGuard` in `shared-auth` rendered `children` unconditionally with no role check at all — never wired up to any app, but would have been a real security bug if it had been).

**Real gap found and fixed, not just deduplicated:** each app had grown its own "extended role membership" rule beyond a flat `role` string check — admin-panel treated `role === 'superadmin'` or `roles.admin === true` as admin; vendor-panel treated `roles.vendor.status === 'verified'` or `roles.vendor === true` as vendor; rider-panel treated `role === 'delivery_agent'` or `roles.delivery` as delivery. But each guard only applied *its own* app's rule. Concretely: `vendor-panel` and `rider-panel` both call `<AuthGuard allowedRoles={['vendor'|'delivery', 'admin']}>` — intending admins to reach every portal — but neither guard's `admin` check understood `role === 'superadmin'`, only admin-panel's did. **A user with `role: 'superadmin'` (as opposed to the hardcoded-email or `is_superadmin: true` paths, both of which every guard already handled) could reach admin-panel but not vendor-panel or rider-panel**, despite both explicitly listing `'admin'` in `allowedRoles`. Fixed by applying every extended-membership rule to every role named in `allowedRoles`, not just the app's "home" role — a deliberate widening of access to match what each call site already declared as intent, never a narrowing. Documented inline in the shared component; flagging here since it's a real behavior change, not silent.

Also: `roles` (the multi-role membership map every guard read via `(user as any)?.roles?.x`) was never actually declared on the `AppUser` type — added it properly to `@dabzzo/shared-types` now that a real typed consumer (`AuthGuard`) exists, removing the need for those `any` casts at the type level.

Each app keeps a ~25-line wrapper (`apps/<app>/src/lib/auth/auth-guard.tsx`) that reads its own Zustand store and forwards to the shared component with its own loading-screen copy/color (e.g. admin-panel's dark `bg-slate-950` vs. the others' `bg-ivory`) — the only thing that stayed a per-app fork is presentation, not the security logic. `rider-panel`'s guard also previously computed its `isAllowed` check twice (once in a `useEffect`, once again in the render bail-out) — two copies that happened to agree but could have silently drifted; the shared version computes it once.

**Verified:** typecheck clean on all 5 apps (gig unaffected, has no guard); full builds of web-main, admin-panel, vendor-panel, and rider-panel all succeed.

**Files:** `packages/shared-auth/src/auth-guard.tsx` (rewritten from dead stub), `packages/shared-types/src/index.ts` (`AppUser.roles` added), `apps/{web-main,admin-panel,vendor-panel,rider-panel}/src/lib/auth/auth-guard.tsx` (rewritten as thin wrappers).

---

## 2026-09-12 — Phase 1 (started): shared types + dead-code removal

**`@dabzzo/shared-types` created** — the first of the shared packages the plan calls for. Reconciled the 4 drifted copies of `types/index.ts` into one canonical file at `packages/shared-types/src/index.ts`.

Did this rigorously, not by picking one app's file and hoping: extracted every union type and every interface's field set from all 5 apps' copies and diffed them structurally (script-assisted, not eyeballed) rather than relying on whole-file diffs, which had already misled the earlier planning pass once (see below). Findings:
- All divergences were additive (a narrower app missing fields a wider app had) with **one real conflict**: `vendor-panel`'s `BatchStatus` uniquely included `'picked_up'` — actual code in `apps/vendor-panel/src/app/dashboard/page.tsx` keys a `Record<BatchStatus, ...>` on it. Every other app's copy was missing this value. This is the exact class of bug flagged as a risk in `IMPLEMENTATION_PLAN.md` §2.1 — confirmed real, not hypothetical, and merged in rather than dropped.
- `web-main`'s copy (652 lines) turned out to be the most complete base, not a strict superset as first assumed from a shallower diff — `vendor-panel`'s `picked_up` was the exception. Corrected before merging, not after.
- Every app's `src/types/index.ts` is now a 6-line re-export of `@dabzzo/shared-types` — import call sites (`import { AppUser } from '@/types'`) are unchanged across the whole codebase, only what `@/types` resolves to changed.
- **Verified:** all 5 apps typecheck clean; full builds of `web-main`, `admin-panel`, and `vendor-panel` (the one with the real dependency on `picked_up`) succeed.
- Side effect: web-main's lint errors dropped 369 → 365 (the 4 `no-explicit-any` hits that lived in the old per-app `types/index.ts` no longer exist there).

**Dead code removed (D3, D5 from the plan, both re-confirmed zero call sites immediately before deleting):**
- `RazorpayButton.tsx` + `useRazorpay.ts` — 8 files across all 4 client apps. Confirmed dead everywhere, including web-main, where the real checkout path is `PaymentModal.tsx` → `lib/razorpay.ts` directly.
- `lib/firebaseAdmin.ts` — 4 files, zero imports anywhere.
- `firebase-admin` + `razorpay` npm dependencies removed from all 4 client apps' `package.json`. Root `package.json` keeps `firebase-admin` (genuinely used by 7 scripts under `scripts/` that run at the repo root, e.g. `bootstrap-admin.mjs`) but drops `razorpay` (unused anywhere at root).
- **Verified:** typecheck clean, full builds of `web-main` and `admin-panel` succeed post-removal.

**Root workspace `npm audit`:** 30 → 11 vulnerabilities via non-breaking `npm audit fix`. Remaining 11 (1 critical, 2 high, 8 moderate) all trace back to the pinned `next@16.2.6` (and its `postcss`/`sharp` build-tooling chain) — deliberately **not** force-upgraded mid-refactor, since `next` is exact-pinned across every app and a version bump needs its own isolated testing pass, not to be folded into a types/dead-code cleanup. Tracked as a dedicated near-term task, not silently deferred.

**Files:** `packages/shared-types/` (new — `package.json`, `tsconfig.json`, `src/index.ts`, `README.md`); all 5 apps' `src/types/index.ts`, `package.json`, `next.config.ts` (modified); `RazorpayButton.tsx` × 4, `useRazorpay.ts` × 4, `firebaseAdmin.ts` × 4 (deleted); root `package.json` (modified).

---

## 2026-09-12 — Phase 0: Safety net

**Baseline established:**
- `git init` + baseline commit `9a04ece` (804 files, everything as of session start, nothing changed yet).
- `.gitignore` hardened: added `android/.idea/`, `android/local.properties`, `android/app/build/`, `ios/App/Pods/`, `*.iml`, `.xcuserstate` and related IDE/build-artifact patterns not previously covered.
- `npm --prefix functions install` (529 packages) — `functions/` had never been installed, which is why its `tsc --noEmit` appeared broken. Confirmed clean once installed.
- `npm audit fix` (non-breaking) on `functions/`: 22 → 13 vulnerabilities. Eliminated 1 critical (`websocket-driver`) and all 6 high-severity findings. Remaining 13 moderate are all transitively pinned by `firebase-admin`'s dependency tree on an old `uuid`; fixing those needs a `firebase-admin` major version bump, deliberately deferred (not done silently — would need testing against the actual Cloud Functions before landing).
- `functions` test baseline: 47/47 passing across 3 suites (`deliveryRedesign`, `deliveryTriggers`, `pricingEngine`). A 4th file, `integration.test.ts`, is excluded from the build — see finding below.
- Added `typecheck` npm script to all 5 apps and to `functions/`; added root `npm run verify` (`typecheck:apps` + `typecheck:functions` + `lint:apps` + `test:functions`) as the one command that answers "is anything broken."
- Added `.env.example` (repo root) and `functions/.env.example` — keys only, documents which vars are client-safe vs. server-only-never-NEXT_PUBLIC.
- **Files:** `.gitignore`, `package.json` (root + 5 apps + functions), `.env.example`, `functions/.env.example` — new.

### 🔴 Critical, fixed immediately: hardcoded live Razorpay secrets in source

**Found:** `functions/src/razorpayFunctions.ts` had three `process.env.X || 'literal'` fallbacks using real, live values:
- `RAZORPAY_KEY_ID` → a live (`rzp_live_...`) key id
- `RAZORPAY_KEY_SECRET` → the paired API secret
- `RAZORPAY_WEBHOOK_SECRET` → the webhook HMAC signature secret (also readable via a `NEXT_PUBLIC_*`-named var, which would have leaked it into the browser bundle had anyone ever set that variant)

Anyone who could read this source file had live payment-gateway API access and could forge webhook signatures to fabricate "payment succeeded" events.

**Fixed:** all three fallbacks removed. Each now throws (`HttpsError('failed-precondition', ...)`) or returns `500` if the real env var is missing, instead of silently authenticating with an exposed value. Verified: `functions` typecheck clean, 47/47 tests still pass.

**⚠️ Outstanding, requires you:**
1. Rotate both the Razorpay API key secret and the webhook secret in the Razorpay dashboard — treat the old ones as compromised regardless of git history, since they were plaintext in a source file.
2. Before deploying this fix, confirm `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are actually configured in the deployed Cloud Functions environment (`firebase functions:secrets:access RAZORPAY_KEY_SECRET`, or the Firebase console). If they aren't, this fix will make live payments/webhooks start failing the moment it ships — right now they're silently authenticating with the leaked literal instead.

**Files:** `functions/src/razorpayFunctions.ts` — modified.

### 🟠 Root `.env`/`.env.local` never reached any app's build

**Found:** Next.js reads `.env`/`.env.local` from `process.cwd()`. Every app under `apps/*` builds with its own directory as cwd, and none had its own `.env` file — so the root `.env` was inert. The gap was masked by a hardcoded Firebase-project-config fallback baked into `lib/firebase.ts` in all 4 client apps (same anti-pattern as the Razorpay finding, lower severity since Firebase web config isn't secret — but it meant a prior claim in `.agents/skills/task.md` ("Move Firebase config to env vars") wasn't actually true in practice, and a staging/dev build with different env vars would have silently written to production Firestore instead).

**Fixed:**
- New `scripts/sync-env.mjs` copies root `.env`/`.env.local` into each `apps/*` directory (gitignored copies, never committed).
- Wired into every app's `predev`/`prebuild` npm scripts, and into `scripts/build-web.mjs` directly (it calls `next build` via `execSync`, bypassing npm lifecycle hooks).
- Removed the hardcoded Firebase config literal from all 4 apps' `lib/firebase.ts`; replaced with a `requireEnv()` helper that fails loudly on a missing var instead of silently substituting another project's config.
- **Verified end-to-end:** rebuilt all 5 apps from a clean env sync — all succeeded; build logs confirmed `Environments: .env.local, .env` were actually loaded.

**Files:** `scripts/sync-env.mjs` (new), `scripts/build-web.mjs`, `apps/{web-main,admin-panel,vendor-panel,rider-panel}/src/lib/firebase.ts`, all 5 apps' `package.json` — modified.

### 🟡 `eslint.config.mjs` global ignores didn't actually match per-app builds

**Found:** the root `eslint.config.mjs`'s `globalIgnores(['.next/**', 'out/**', 'build/**'])` is resolved relative to the *config file's* directory (repo root), not the invoking cwd. Every app's `"lint": "eslint"` script runs with cwd = `apps/<name>` (via npm workspaces), so those patterns never matched `apps/<name>/out/**` or `apps/<name>/.next/**` at all. As long as no build had run yet in the working tree, this was invisible — nothing existed there to lint. The moment a build runs (exactly what a CI pipeline does before or after lint), a plain `npm run lint` scans the entire minified build output as source: verified this inflates web-main's lint run from 369 errors / 215 warnings to **1,944 errors / 24,104 warnings** on the same source tree.

**Fixed:** patterns changed to `**/.next/**`, `**/out/**`, `**/build/**`, `**/next-env.d.ts` (leading `**/` matches at any depth regardless of invocation directory). Verified: re-ran lint on web-main immediately after a full build — back to 369/215, matching the true source-only baseline.

**Files:** `eslint.config.mjs` — modified. **This would otherwise have broken CI the first time it ran lint after a build**, exactly the scenario Phase 6 (deployment readiness) is meant to catch — caught now instead.

### 🟡 `functions/src/__tests__/integration.test.ts` is orphaned, not just untested

Imports `../../src/lib/queries/{delivery,swaps,credits}` and the *client* `firebase/firestore` SDK — none of which exist under `functions/src/`; those paths and APIs belong to the web apps' query layer (`apps/*/src/lib/queries/*.ts`). It cannot compile from where it sits, which is why `tsconfig.test.json` explicitly excludes it. No app in the monorepo has Jest configured at all, so this file currently has no valid home. Not fixed yet — deferred to Phase 4, documented here rather than left silently excluded.

### Repo-wide lint baseline (post-eslint-config-fix, source only)

| App | Errors | Warnings | Total |
|---|---|---|---|
| web-main | 369 | 215 | 584 |
| admin-panel | 296 | 227 | 523 |
| vendor-panel | 241 | 99 | 340 |
| rider-panel | 230 | 88 | 318 |
| gig | 6 | 1 | 7 |
| **Total** | **1,142** | **630** | **1,772** |

### `npm run verify` redesigned mid-Phase-0

The first version chained steps with `&&`, so a failing `lint:apps` (which is currently guaranteed, given the table above) silently prevented `test:functions` from ever running — the opposite of what a "tell me everything that's broken" script should do. Replaced with `scripts/verify.mjs`, which runs all four steps unconditionally and prints a pass/fail summary at the end, exiting non-zero only if something failed. **Files:** `scripts/verify.mjs` (new), `package.json` (`verify` script now calls it).

No code changes made to app source logic yet beyond the security fixes above — Phase 1 (canonicalize shared code) has not started.
