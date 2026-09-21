# Dabzzo — Phase 26 Product Hardening · Implementation Report

**Date:** 2026-09-22 · **Owner:** Engineering · **Status:** Complete
**Companion entries:** [CHANGELOG.md](CHANGELOG.md) 2026-09-22 · [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) "Update — 2026-09-22"

---

## 1. Executive summary

Phase 26 closed four product-level gaps found while exercising the live delivery/subscription flows:

1. **P0** — the rider callable could set *any* delivery status, so an order could be regressed `DELIVERED → ASSIGNED`. Now hard-whitelisted.
2. **One lifecycle source of truth** — the customer Track/Orders views, the tracking card and the rider/vendor panels all compute "is this order live?" from different private lists; `created`/`ready` orders rendered "No Active Delivery" on Track, and a failing listener could leave Track's spinner forever.
3. **Audit gap** — nightly expiry sweeps mutated subscriptions/users with no audit trail.
4. **Ops UX** — the vendor prep card had no drill-down, and the rider IDLE queue was unordered/unlabeled.

All four are shipped. **Verification:** functions 152/152 tests (5 new), all apps + packages typecheck, lint 0 errors.

---

## 2. Scope of change

| Area | Component(s) | Change type |
|---|---|---|
| Functions | `deliveryTriggers.ts` | Behavior hardening (P0) |
| Shared | `shared-lib/src/orderLifecycle.ts` → `./orderLifecycle` | New canonical module |
| Functions | `auditUtils.ts` + `subscriptionExpiry.ts` | New audit capability |
| Shared-queries | `packages/shared-queries/src/delivery.ts` | New `getVendorPrepDetails` |
| Customer | `track`, `orders`, `RiderTrackingCard` | Shared-model adoption + bugfix |
| Vendor | `vendor-panel dashboard` | Drill-down modal |
| Rider | `rider-panel dashboard` | Sort/NEXT/aria/summary |
| Tests | `deliveryTriggers.test.ts` (+3), `auditUtils.test.ts` (new, +2) | Pinning regressions |

---

## 3. Item-by-item

### 3.1 P0 — Delivery-transition integrity (functions)

**The bug.** `updateDeliveryStatus(orderId, status, ...)` validated the incoming status only when it hit one of four transition guards. Any other value fell through to a raw `update()` with that status string. Verified reachable: `DELIVERED → ASSIGNED`, `DELIVERED → PREPARING`, arbitrary garbage committed to Firestore — corrupting order history and downstream display for everyone.

**The fix.** `functions/src/deliveryTriggers.ts` — before constructing the transaction, the target status must be in `DELIVERY_TARGET_STATUSES = ['picked_up', 'out_for_delivery', 'delivered', 'failed_attempt']`, else throw `invalid-argument` with `` `Cannot set delivery status to "${status}" — only rider delivery statuses are allowed` ``. Read/write never happens for bad input. The `picked_up` guard's `pending`/`created` prestates are untouched (the direct "mark picked up" flow depends on them). `verifyDeliveryOTP` remains the OTP-gated path to `delivered`.

**Not changed (deliberate).** Prestate/transition matrix for the four legitimate statuses; `delivered` auto-update of `delivery.status`.

### 3.2 One order-lifecycle source of truth (shared-lib + web-main)

New `packages/shared-lib/src/orderLifecycle.ts` — the canonical 20-status vocabulary and the sets/helpers panels were hand-rolling:

- `LIVE_TRACKING_STATUSES` (14) — all pre-dispatch + in-flight stages, incl. merged aliases `preparing` and `picking_up` that SQL data surfaced.
- `DELIVERED_STATUSES`, `INACTIVE_STATUSES`, `ACTIVE_ORDER_STATUSES` (= live + delivered), `ORDER_STATUS_LABELS`, `orderStatusLabel()`.
- `statusToLifecycleStage()` — maps every status → the 5-step customer timeline index (or `null` for inactive), plus `isLiveStatus` / `isDeliveredStatus` / `isInactiveStatus`.

**Track page** (`apps/web-main/src/app/(user)/track/page.tsx`): previously `liveOrder` was filtered by a private status list that A/O **skipped `created`/`ready`** → a real today-order showed only "No Active Delivery". Now any non-terminal today order renders the live timeline (`isLiveStatus`), delivered/terminal render the summary (delivered) or not-delivered card (failed) — `failed` is deliberately kept out of `liveOrder`. **Second bug fixed:** when any of the three data listeners failed, `loading` was only cleared by the *next* success callback — a failing listener left the permanent spinner. Error callbacks now `setLoading(false)` out.

**Orders page** (`orders/page.tsx`): `LIVE_TRACKING_STATUSES` drives the active-orders query (spread into the `in` list), `ACTIVE_ORDER_STATUSES` drives `hasTodayOrder` / "Track this meal" banner.

**RiderTrackingCard** (`web-main/src/components/delivery/RiderTrackingCard.tsx`): any canonical status now maps to a defined step via `statusToLifecycleStage` (raw-status pills for unknown statuses gone); per-status cycling `STATUS_MESSAGES` expanded to all 20. The **5-step layout is a hard constraint** (`justify-between` on a ~350px card) — the adapter maps onto 5 steps rather than growing the UI.

**Decision log.** `apps/web-main/src/app/(user)/dashboard/page.tsx` ACTIVE_STATUSES was left as-is: switching it to `ACTIVE_ORDER_STATUSES` would surface *delivered* orders as the active card (behavior change, out of scope). admin dashboard kitchen-override list untouched (needs the full status set).

### 3.3 Subscription-expiry audit trail (functions)

New `functions/src/auditUtils.ts` — `writeAuditLog(entry, db?)` appends `audit_logs` docs with **both** snake_case (`actor_uid`, `target_uid`, `target_type`, `target_id`, `created_at`) and camelCase keys (client mirrors), server timestamps, and injected-db support for tests.

`expireSubscriptions` now records:
- `subscription.expiry.sweep` per run — sweep id, expired count, affected user ids.
- `subscription.expiry.user_clear` per user — the entitlement-flag wipe.

Automated system mutations now match the callable-admin audit standard.

### 3.4 Vendor prep drill-down (shared-queries + vendor-panel)

`packages/shared-queries/src/delivery.ts`: `getVendorPrepDetails(vendorId, date)` returns today's underlying order rows (customer, meal, status, address, rider, box tag, created-at) from the existing `vendor_id + date` composite query; `buildPrepRows` normalizes (incl. legacy `vendorId` field via dual query). `vendor-panel/.../dashboard/page.tsx`: prep-breakdown card → **View Orders** bottom sheet listing today's tiffins newest-first with status chips, call links, rider info, plus an amber "cancelled/skipped need attention" line; six dead icon imports removed.

### 3.5 Rider IDLE queue UX (rider-panel)

`apps/rider-panel/.../dashboard/page.tsx`:
- Queue sorted by stage (in-flight first by progression, terminal last) via a rank map.
- First remaining stop gets a **NEXT** badge + brand ring highlight.
- Header summary: `{inFlight} to go / {done} done / {failed} failed`.
- All nine icon-only controls gained `aria-label` alongside their `title` (queue call/map, kitchen call/navigate, drop navigation, profile photo, logout).

---

## 4. Verification evidence

| Check | Invocation | Result |
|---|---|---|
| shared-lib typecheck | `npm run typecheck -w @dabzzo/shared-lib` | pass |
| functions tests | `npm run test:functions` | **152/152** (+5) |
| `deliveryTriggers.test.ts` | — | 3 new: `cancelled` / `rider_assigned` / `ready` all rejected `invalid-argument` |
| `auditUtils.test.ts` | — | 2 new: payload shape (snake+camel), nulled optional fields |
| all apps + packages typecheck | `npm run typecheck:apps` | pass (admin/gig/rider/vendor/web-main, shared-auth/lib/queries/types/ui) |
| functions typecheck | `npm run typecheck:functions` | pass |
| lint | `npm run lint:apps` | 0 errors; changed files show only the repo-wide pre-existing `react-hooks/set-state-in-effect` warnings |

Command quirk: use `-w @dabzzo/shared-lib` — `--workspace=shared-lib` fails with "No workspaces found".

## 5. Risks / follow-ups

- **5-step timeline is a hard layout cap.** Future statuses / stages that don't fit 5 steps need a redesign of `RiderTrackingCard`'s `justify-between` layout, not a new step appended.
- **`preparing` alias.** `orderLifecycle` includes `preparing` (found in data) though it is not in shared-types `OrderStatus`. Consider promoting it to the union.
- **Migration note** (low): `expireSubscriptions` sweep id uses a run-scoped `sweepRunId`; future sweeps should reuse the generator to keep `audit_logs` correlation stable.
- Not attempted here (out of scope): migrating `apps/web-main/(user)/dashboard` and admin panel to the shared sets (see decision log).