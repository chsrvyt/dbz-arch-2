/**
 * ORDER LIFECYCLE — single source of truth for order-status grouping, labels,
 * and the customer-facing tracking timeline.
 *
 * Historically every panel (track, orders, customer dashboard, admin) repeated
 * its own hand-rolled "live status" array with subtly different membership.
 * That caused real product bugs — e.g. the Track page showed "No Active
 * Delivery" for an order in `created`/`ready` because those statuses were never
 * in the live set, while a non-order status (`picking_up`, which belongs to
 * rider_trips) was treated as live. This module centralizes the sets so every
 * panel agrees.
 */

/** Full canonical order status vocabulary (snake + camel forms both appear in the wild). */
export const ORDER_STATUSES = [
  'created',
  'vendor_notified',
  'vendor_preparing',
  'vendor_ready',
  'cooking',
  'ready',
  'dispatched',
  'rider_assigned',
  'rider_en_route_pickup',
  'picking_up',
  'picked_up',
  'out_for_delivery',
  'delivered',
  'completed',
  'pending',
  'preparing',
  'failed',
  'cancelled',
  'skipped',
  'swapped_out',
  'swapped_in',
] as const;

export type OrderLifecycleStatus = (typeof ORDER_STATUSES)[number];

/**
 * Statuses that render a live tracking timeline on the customer Track page.
 * Broadened to include every pre-dispatch stage so "Tap Track → No Active
 * Delivery" cannot happen while a real, today-dated order doc exists.
 * `picking_up` is retained defensively even though it primarily belongs to
 * rider_trips, so a legacy order carrying it still tracks correctly.
 */
export const LIVE_TRACKING_STATUSES: readonly OrderLifecycleStatus[] = [
  'created',
  'pending',
  'vendor_notified',
  'vendor_preparing',
  'cooking',
  'preparing',
  'vendor_ready',
  'ready',
  'dispatched',
  'rider_assigned',
  'rider_en_route_pickup',
  'picking_up',
  'picked_up',
  'out_for_delivery',
];

/** Statuses that count as successfully fulfilled. */
export const DELIVERED_STATUSES: readonly OrderLifecycleStatus[] = ['delivered', 'completed'];

/** Terminal statuses that are no longer trackable or actionable. */
export const INACTIVE_STATUSES: readonly OrderLifecycleStatus[] = [
  'failed',
  'cancelled',
  'skipped',
  'swapped_out',
  'swapped_in',
];

/**
 * The "everything that matters today" set — live in-flight orders plus ones
 * already delivered. Used by dashboards and the orders page instead of rolling
 * their own list.
 */
export const ACTIVE_ORDER_STATUSES: readonly OrderLifecycleStatus[] = [
  ...LIVE_TRACKING_STATUSES,
  ...DELIVERED_STATUSES,
];

/** Human labels for every status. Falls back to a humanized raw string. */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  created: 'Confirmed',
  pending: 'Pending',
  vendor_notified: 'Vendor notified',
  vendor_preparing: 'Preparing',
  cooking: 'Cooking',
  preparing: 'Preparing',
  vendor_ready: 'Ready for pickup',
  ready: 'Ready',
  dispatched: 'Dispatched',
  rider_assigned: 'Rider assigned',
  rider_en_route_pickup: 'Rider to pickup',
  picking_up: 'Rider picking up',
  picked_up: 'Picked up',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  completed: 'Completed',
  failed: 'Failed',
  failed_attempt: 'Delivery attempt failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  swapped_out: 'Swapped out',
  swapped_in: 'Swapped in',
};

/** Pretty label for any status value, unknown values included. */
export function orderStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Unknown';
  const label = ORDER_STATUS_LABELS[status];
  if (label) return label;
  return status.replace(/_/g, ' ');
}

/**
 * The five-stage customer tracking timeline (matches the visual steps rendered
 * by RiderTrackingCard). Maps every canonical status onto exactly one stage so
 * the Track page always draws a meaningful checkpoint, never a raw status
 * string. Inactive/terminal statuses map to `null` (no timeline).
 */
export interface LifecycleStage {
  /** 0-based index into the 5 visual steps. */
  index: number;
  /** Stable key for the stage. */
  key: string;
  /** Short label shown on the pill / step chip. */
  label: string;
}

export function statusToLifecycleStage(status: string | null | undefined): LifecycleStage | null {
  switch (status) {
    case 'delivered':
    case 'completed':
      return { index: 4, key: 'delivered', label: 'Delivered' };
    case 'out_for_delivery':
      return { index: 3, key: 'out_for_delivery', label: 'En Route' };
    case 'rider_en_route_pickup':
    case 'picking_up':
    case 'picked_up':
      return { index: 2, key: 'picked_up', label: 'Picked Up' };
    case 'vendor_ready':
    case 'ready':
    case 'dispatched':
    case 'rider_assigned':
      return { index: 1, key: 'ready', label: 'Ready / Assigned' };
    case 'created':
    case 'pending':
    case 'vendor_notified':
    case 'vendor_preparing':
    case 'cooking':
    case 'preparing':
      return { index: 0, key: 'preparing', label: 'Preparing' };
    default:
      return null;
  }
}

/** True when a status is currently in-flight and trackable as an active delivery. */
export function isLiveStatus(status: string | null | undefined): boolean {
  return !!status && (LIVE_TRACKING_STATUSES as readonly string[]).includes(status);
}

/** True when a status is delivered/completed (successfully fulfilled). */
export function isDeliveredStatus(status: string | null | undefined): boolean {
  return !!status && (DELIVERED_STATUSES as readonly string[]).includes(status);
}

/** True when a status is terminal and no longer actionable. */
export function isInactiveStatus(status: string | null | undefined): boolean {
  return !!status && (INACTIVE_STATUSES as readonly string[]).includes(status);
}