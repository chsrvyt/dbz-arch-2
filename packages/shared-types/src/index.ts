// ─── Dabzzo core data model — SINGLE SOURCE OF TRUTH ──────────────────────────
//
// Every app under apps/* re-exports this file (`export * from '@dabzzo/shared-types'`)
// instead of keeping its own copy. Prior to this consolidation, 4 near-duplicate
// copies of this file existed and had drifted (see IMPLEMENTATION_PLAN.md Phase 1
// and CHANGELOG.md for the full divergence analysis). Do not fork this file again —
// if one app genuinely needs a field the others don't, add it here; every app
// getting a field it doesn't use is a much smaller cost than 4 different
// definitions of what a Subscription or AppUser is.

// ─── Core Types ──────────────────────────────────────────────────────────────

export type UserRole = 'user' | 'vendor' | 'delivery' | 'admin' | 'superadmin';

export type DietaryCategory = 'veg' | 'non_veg';

export interface VendorAddon {
  id: string;
  name: string;
  monthly_price: number;
  weekly_price?: number;
  onetime_price?: number;
  active: boolean;
  description?: string;
}

export interface SelectedAddon {
  id: string;
  name: string;
  monthly_price: number;
  weekly_price?: number;
  onetime_price?: number;
  price_paid: number;
}

export interface AppUser {
  id: string;          // Firebase Auth UID
  name: string;
  /**
   * Server-assigned unique referral code (referral_codes/{code} registry).
   * Assigned lazily by Cloud Functions; never written directly by the client.
   */
  referral_code?: string;
  /**
   * Referral code that invited THIS user. Immutable once set — only the
   * server-side applyReferralCode callable may write it. Referral completion
   * is credited when this user activates a subscription.
   */
  referred_by?: string;
  /** True once this user's referral event is counted as completed. */
  referral_completed?: boolean;
  phone: string;       // 10-digit, required for on-ground operations (set during onboarding)
  role: UserRole;
  email?: string;      // Provided from social auth (Google, Apple, Facebook)
  image?: string;      // Profile photo from social provider
  is_superadmin?: boolean; // Only closeon.st@gmail.com
  // Multi-role membership map, used by AuthGuard's extended-role-membership
  // checks (packages/shared-auth/src/auth-guard.tsx) — previously accessed
  // everywhere via `user?.roles?.x` because this field was never
  // actually declared. `vendor` can be a plain boolean or carry a
  // verification status; `admin`/`delivery` are booleans in current usage.
  roles?: {
    admin?: boolean;
    vendor?: boolean | { status?: string };
    delivery?: boolean;
  };
  is_approved?: boolean;
  is_rejected?: boolean;
  /**
   * Set once, the first time the phone-capture screen is shown.
   *
   * The prompt used to be driven purely by "is phone empty", which meant
   * anyone whose number failed to save was asked again on every sign-in. This
   * flag makes it strictly one-time: asked once, never again, whether or not
   * a number was actually entered. A phone can still be added later from the
   * profile screen.
   */
  phone_prompt_shown?: boolean;
  push_tokens?: string[];
  location?: { lat: number; lng: number; updated_at: number };
  address?: string;
  deliveryPreference?: '8am' | '11am';
  is_active_subscriber?: boolean;
  membership_status?: 'active' | 'inactive' | 'pending';
  active_subscription_id?: string;
  // Vendor-specific
  kitchen_name?: string;
  bio?: string;
  cuisine_type?: string;
  // Dietary categories supported: ['veg'] | ['non_veg'] | ['veg', 'non_veg']
  dietary_categories?: DietaryCategory[];
  // One-time: flat price per meal (no lunch/dinner distinction)
  rate_onetime?: number;
  // Weekly subscription rates per meal type
  rate_lunch_weekly?: number;
  rate_dinner_weekly?: number;
  rate_both_weekly?: number;
  // Monthly subscription rates per meal type
  rate_lunch_monthly?: number;
  rate_dinner_monthly?: number;
  rate_both_monthly?: number;

  // 🌿 Pure Veg Specific Rates
  rate_veg_onetime?: number;
  rate_veg_lunch_weekly?: number;
  rate_veg_dinner_weekly?: number;
  rate_veg_both_weekly?: number;
  rate_veg_lunch_monthly?: number;
  rate_veg_dinner_monthly?: number;
  rate_veg_both_monthly?: number;

  // 🍗 Non-Veg Specific Rates
  rate_nonveg_onetime?: number;
  rate_nonveg_lunch_weekly?: number;
  rate_nonveg_dinner_weekly?: number;
  rate_nonveg_both_weekly?: number;
  rate_nonveg_lunch_monthly?: number;
  rate_nonveg_dinner_monthly?: number;
  rate_nonveg_both_monthly?: number;

  // Vendor Add-Ons (Sweets, sides, extras)
  addons?: VendorAddon[];

  // Legacy fields kept for backward compat
  rate_lunch?: number;
  rate_dinner?: number;
  rate_both?: number;
  rating?: number;
  review_count?: number;
  rating_avg?: number;
  subscriberCount?: number;
  capacity?: number;
  capacityUnlimited?: boolean;
  upi_id?: string;
  // Razorpay Route (Settlements)
  rzp_account_id?: string;
  bank_details?: {
    account_number: string;
    ifsc: string;
    beneficiary_name: string;
  };
  platform_fee_pct?: number;
  // Suspension flag, set by the admin console's suspend/unsuspend action.
  is_suspended?: boolean;
  // Trading name, where it differs from `name` (used on vendor records).
  business_name?: string;
  // Rider compensation, where a fixed arrangement replaces per-trip payout.
  salary?: number;
  monthly_salary?: number;
  // Flat per-meal payout agreed with this kitchen, before margin.
  vendor_base_payout?: number;
  // Fluctuation margin override for this specific kitchen (e.g. 40%)
  vendor_margin_percent?: number;
  vendor_margin_override?: number;
  standard_meal_payout?: number;
  // Component rates override for this specific kitchen
  custom_component_rates?: Record<string, number | { vendorRate?: number; customerRate?: number }>;
  // Partner Verification
  verification_status?: 'pending' | 'details_requested' | 'verified' | 'rejected';
  admin_note?: string;
  requested_fields?: string[];
  fssai_license?: string;
  vehicle_type?: string;
  vehicle_number?: string;
  license_number?: string;
  created_at?: FirestoreTimestamp;
  updated_at?: FirestoreTimestamp;
}

export interface FirestoreTimestamp {
  seconds: number;
  nanoseconds: number;
  toDate?: () => Date;
}

// ─── Vendors ─────────────────────────────────────────────────────────────────

export interface Vendor extends AppUser {
  subscriberCount?: number;
  startingPrice?: number | null;
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

export type SubscriptionStatus = 'active' | 'paused' | 'cancelled';
export type MealType = 'lunch' | 'dinner' | 'both';

export type SubscriptionFrequency = 'one-time' | 'weekly' | 'monthly';

export interface Subscription {
  id: string;
  user_id: string;
  vendor_id: string;
  plan_id: string;
  meal_type: MealType;
  category?: DietaryCategory;
  frequency?: SubscriptionFrequency;
  status: SubscriptionStatus;
  price?: number; // current rate in ₹ — set when vendor updates meal rates
  selected_addons?: SelectedAddon[];
  base_price?: number;
  addons_price?: number;
  total_price?: number;
  paid_amount?: number;
  payment_id?: string;
  razorpay_order_id?: string;
  discount_pct?: number;
  promo_code?: string;
  custom_meal_config?: CustomMealConfig;
  meal_components?: string[];
  // Denormalised vendor name copied onto the subscription doc.
  vendor_name?: string;
  // Custom-plan builder output. These were read through `as any` casts in the
  // UI; declared here so the reads are checked.
  subscriptionType?: 'custom_weekly' | 'custom_monthly' | string;
  deliveryPattern?: Record<string, number>;
  customPlan?: {
    totalPrice?: number;
    pattern?: Record<string, number>;
    [key: string]: unknown;
  };
  created_at: FirestoreTimestamp;
  next_billing_date?: FirestoreTimestamp;
  cancelled_at?: FirestoreTimestamp;
  cancelled_by?: string;
}

export interface SubscriptionPlan {
  id: string;
  title: string;
  price: number;
  frequency: string;
  meal_type: MealType;
  category?: DietaryCategory;
  vendor_id?: string;
}

export interface EnrichedSubscription extends Subscription {
  userName?: string;
  userPhone?: string;
  vendorName?: string;
  vendorImage?: string;
  planTitle?: string;
  planPrice?: number;
  planFrequency?: string;
  createdMs?: number;
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

export interface Review {
  id: string;
  vendor_id: string;
  user_id: string;
  user_name: string;
  rating: number;
  review_text?: string;
  created_at: FirestoreTimestamp;
}

// ─── Support Tickets ─────────────────────────────────────────────────────────

export type TicketStatus = 'open' | 'in_progress' | 'resolved';

export interface TicketReply {
  from_role: UserRole | 'admin';
  from_name: string;
  message: string;
  timestamp: FirestoreTimestamp;
}

export interface SupportTicket {
  id: string;
  submitter_id: string;
  submitter_name: string;
  role: UserRole;
  subject: string;
  message: string;
  status: TicketStatus;
  replies: TicketReply[];
  created_at: FirestoreTimestamp;
  updated_at: FirestoreTimestamp;
}

// ─── Daily Menu ──────────────────────────────────────────────────────────────

export interface MenuItem {
  name: string;
  description?: string;
}

export interface DailyMenu {
  id: string;
  vendor_id: string;
  date: string; // YYYY-MM-DD
  items: (MenuItem | string)[];
  note?: string;
  items_veg?: (MenuItem | string)[];
  items_non_veg?: (MenuItem | string)[];
  note_veg?: string;
  note_non_veg?: string;
}

// ─── Discount Codes ──────────────────────────────────────────────────────────

export interface DiscountCode {
  id: string;
  code: string;
  discount_pct: number;
  active: boolean;
  vendor_id?: string;
  created_at: FirestoreTimestamp;
  // ── Referral coupon fields ───────────────────────────────────────────────
  /** 'referral' for milestone awards; vendor promo codes leave this undefined. */
  source?: 'vendor' | 'referral';
  /** Referral coupons only ever apply to monthly plans; server validates. */
  plan_type?: 'weekly' | 'monthly' | 'one-time';
  /** Owner of the coupon — server rejects any other caller. */
  user_id?: string;
  /** Milestone id this coupon was earned from (e.g. '3'). */
  milestone?: string;
  status?: 'available' | 'used';
  used_at?: FirestoreTimestamp;
  subscription_id?: string;
}

// ─── Referrals & Milestone Rewards ──────────────────────────────────────────

export type ReferralStatus = 'pending' | 'completed' | 'rejected';

export interface Referral {
  id: string;
  referrer_user_id: string;
  referral_code: string;
  referred_user_id: string;
  referred_phone?: string;
  status: ReferralStatus;
  created_at: FirestoreTimestamp;
  completed_at?: FirestoreTimestamp;
  rejected_reason?: string;
}

/** Single reward tier: N successful referrals → discount% off a monthly plan. */
export interface ReferralMilestone {
  id: string;
  threshold: number;
  discount: number; // percent off
}

export type ReferralClaimStatus = 'available' | 'used';

/**
 * One-time claim of a milestone reward. The document id is
 * `referral_milestone_claims/{userId}_{milestoneId}` which enforces the
 * UNIQUE(user_id, milestone_id) constraint at the Firestore level.
 */
export interface ReferralMilestoneClaim {
  id: string;
  user_id: string;
  milestone_id: string;
  threshold: number;
  discount_percentage: number;
  coupon_code: string;
  status: ReferralClaimStatus;
  claimed_at: FirestoreTimestamp;
  used_at?: FirestoreTimestamp;
}

/** Per-milestone status for the client dashboard (LO/UNLOCK/CLAIMED). */
export interface ReferralMilestoneStatus {
  id: string;
  threshold: number;
  discount: number;
  unlocked: boolean;
  claimed: boolean;
  couponCode?: string;
  couponStatus?: ReferralClaimStatus;
}

/** Server-computed payload for the "Refer & Earn" dashboard. */
export interface ReferralDashboardData {
  referralCode: string;
  referralLink: string;
  completedReferrals: number;
  milestones: ReferralMilestoneStatus[];
}

// ─── Orders (Canonical DBZ V2 Schema - Prompt 1) ──────────────────────────────

export type OrderStatus = 
  | 'created' 
  | 'vendor_notified' 
  | 'vendor_preparing' 
  | 'vendor_ready' 
  | 'rider_assigned' 
  | 'rider_en_route_pickup' 
  | 'picked_up' 
  | 'out_for_delivery' 
  | 'delivered' 
  | 'skipped' 
  | 'swapped_out' 
  | 'swapped_in' 
  | 'failed' 
  | 'completed'
  | 'pending'
  | 'cooking'
  | 'ready'
  | 'dispatched'
  | 'cancelled';

export interface DeliveryAddress {
  line1?: string;
  lat?: number;
  lng?: number;
}

export interface Order {
  id: string;                  // format: ORD-{date}-{sequence}
  user_id: string;
  date: string;                // YYYY-MM-DD
  meal_type: MealType;
  delivery_slot: string;       // '8am', '11am', '8pm'
  vendor_id?: string;          // Nullable until batch assignment
  batch_id?: string;           // Nullable until batch assignment, FK to Batch
  /**
   * Snapshot at order creation. Genuinely polymorphic in Firestore: the
   * delivery trigger (functions/src/deliveryTriggers.ts) writes an object with
   * coordinates, while subscription creation writes a plain address string.
   * Typed as the union so call sites have to handle both — reading `.lat` off
   * the string form silently yields undefined, which is how the swap-candidate
   * search could quietly match nobody.
   */
  delivery_address: string | DeliveryAddress;
  status: OrderStatus;
  total_amount?: number;
  amount?: number;
  price?: number;
  swap_ref?: string;           // Nullable, FK to SwapRequest
  skip_ref?: string;           // Nullable, FK to SkipRecord
  rider_trip_id?: string;      // Nullable, FK once assigned
  legacy_order_id?: string;    // Traceability for migration
  created_at: FirestoreTimestamp;
  updated_at: FirestoreTimestamp;
}

/**
 * What an `orders` document actually looks like in Firestore today.
 *
 * `Order` above is the canonical schema. Real documents also still carry
 * camelCase fields from before the consolidation described in
 * deliveryTriggers.ts, because existing documents were never backfilled. Code
 * reading orders was casting `snap.data() as any` to reach them, which turned
 * off checking for the canonical fields too.
 *
 * Use this type (via the converters in @dabzzo/shared-queries/converters) when
 * READING order documents. Use `Order` when writing new ones — new documents
 * should only use the canonical names.
 */
export interface LegacyOrderFields {
  /** Pre-consolidation alias for `user_id`. */
  customerId?: string;
  /** Pre-consolidation alias for `vendor_id`. */
  vendorId?: string;
  /** Pre-consolidation alias for the assigned rider. */
  driverId?: string;
  /** Pre-consolidation alias for `subscription_id`. */
  subscriptionId?: string;
  /** Pre-consolidation alias for `delivery_slot`. */
  scheduledSlot?: string;
  /** Pre-consolidation alias for `created_at`. */
  createdAt?: FirestoreTimestamp;
  /** Pre-consolidation alias for `date`. */
  delivery_date?: string;
  subscription_id?: string;
  customer_phone?: string;
  customerPhone?: string;
  vendor_phone?: string;
  vendorPhone?: string;
  address?: string;
  meal?: string;
  order_id?: string;
  rider_id?: string;
  /** Set on client-side projected (not yet persisted) orders. */
  isProjected?: boolean;
}

/** An order document as read from Firestore: canonical fields plus legacy aliases. */
export type StoredOrder = Order & LegacyOrderFields;

export interface OrderStatusLog {
  id: string;
  order_id: string;
  from_status?: OrderStatus;
  to_status: OrderStatus;
  actor: string;               // e.g., 'system', user_id, vendor_id, driver_id
  timestamp: FirestoreTimestamp;
}

// ─── Batches (Order Grouping) ────────────────────────────────────────────────

// NOTE: 'picked_up' was previously present only in vendor-panel's local copy
// of this type (found while consolidating 4 drifted copies into this shared
// package — see IMPLEMENTATION_PLAN.md Phase 1). vendor-panel's dashboard
// code relies on it as a valid batch status; kept here as the merged truth.
export type BatchStatus = 'pending' | 'notified' | 'preparing' | 'ready' | 'pickup_in_progress' | 'picked_up' | 'completed';

export interface Batch {
  id: string;                   // Format: BATCH-{vendor_id}-{date}-{slot}
  vendor_id: string;
  date: string;                 // YYYY-MM-DD
  slot: string;                 // '8am', '11am', '8pm'
  order_ids: string[];          // Array of FKs to Order
  status: BatchStatus;
  total_count: number;          // Active (non-skipped) meal count
  last_notified_count: number;  // Tracks skip updates for debounced vendor notifications
  pickup_otp?: string;          // OTP for rider pickup
  dispatch_attempts?: number;
  current_radius?: number;
  dispatch_started_at?: FirestoreTimestamp;
  created_at: FirestoreTimestamp;
  updated_at: FirestoreTimestamp;
}

// ─── Deliveries (Legacy - Deprecated) ────────────────────────────────────────
export type DeliveryStatus = 'pending' | 'picked_up' | 'delivered' | 'cancelled';

export interface Delivery {
  id: string;
  user_id: string;
  vendor_id: string;
  assigned_to: string;
  status: DeliveryStatus;
  customer_name: string;
  address: string;
  lat?: number;
  lng?: number;
  vendor_name: string;
  meal_type: MealType;
  time_slot: string;
  created_at: FirestoreTimestamp;
  updated_at: FirestoreTimestamp;
}

// ─── Toast ───────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

// ─── Swaps & Credits ─────────────────────────────────────────────────────────

export type SwapRequestStatus = 'broadcasted' | 'matched' | 'expired' | 'company_fulfilled';

export interface SwapRequest {
  id: string;
  initiator_user_id: string;
  initiator_subscription_id: string;
  meal_id: string; // The specific day's tiffin meal ID
  status: SwapRequestStatus;
  is_paid: boolean;
  payment_amount?: number; // e.g., default 50
  created_at: FirestoreTimestamp;
  matched_with_user_id?: string;
  matched_at?: FirestoreTimestamp;
  target_vendor_id?: string; // NEW: the vendor selected for instant swap
}

export type SwapRecipientResponse = 'pending' | 'accepted' | 'declined' | 'expired';

export interface SwapBroadcastRecipient {
  id: string;
  swap_request_id: string;
  recipient_user_id: string;
  distance_km: number;
  meal_snapshot: any; // Full details of the meal being broadcasted
  response: SwapRecipientResponse;
  responded_at?: FirestoreTimestamp;
}

export type UserCreditSource = 'swap_accept' | 'cancellation';

export interface UserCredit {
  id: string;
  user_id: string;
  credit_amount: number; // Decimal (e.g., 0.3, 0.5, 1.0)
  source: UserCreditSource;
  source_reference_id: string; // swap_request_id or cancellation_id
  created_at: FirestoreTimestamp;
  redeemed: boolean;
  redeemed_at?: FirestoreTimestamp;
}

export interface SubscriptionSwapAllowance {
  id: string;
  subscription_id: string;
  plan_type: 'lunch_only' | 'lunch_dinner';
  free_swaps_total: number; // 1 for lunch_only, 2 for lunch_dinner
  free_swaps_used: number;
}

export interface FreeMealVoucher {
  id: string;
  user_id: string;
  status: 'available' | 'used';
  created_at: FirestoreTimestamp;
  used_at?: FirestoreTimestamp;
}

export type AuditLogType = 'swap_initiated' | 'swap_matched' | 'credit_earned' | 'credit_redeemed' | 'delivery_cancelled' | 'undo_skip';

export interface AuditLog {
  id: string;
  type: AuditLogType;
  user_id: string;
  target_user_id?: string;
  amount?: number;
  metadata?: any;
  created_at: FirestoreTimestamp;
}

// ─── Promotional Offers Carousel ─────────────────────────────────────────────

export type OfferLinkType = 'kitchen' | 'none';

export interface Offer {
  id: string;
  imageUrl: string;
  title: string;
  linkType: OfferLinkType;
  linkedKitchenId: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
  createdBy: string;
}

export type CreateOfferInput = Omit<Offer, 'id' | 'createdAt' | 'updatedAt'> & {
  createdAt?: FirestoreTimestamp;
  updatedAt?: FirestoreTimestamp;
};

export type UpdateOfferInput = Partial<Omit<Offer, 'id' | 'createdAt' | 'createdBy'>>;

// ─── Meal Pricing Configuration ───────────────────────────────────────────────

export type PlanPricingType = 'weekly' | 'monthly';

export interface MealPricingConfig {
  id: string; // 'weekly_pricing' | 'monthly_pricing'
  type: PlanPricingType;
  pricePerMeal: number;
  vendorCostPerMeal: number;
  margin: number;
  updatedAt?: FirestoreTimestamp;
  updatedBy?: string;
}

export interface PricingAlgorithmSettings {
  deliveryChargePerMeal: number;       // Default: 13 (₹13)
  vendorMarginPercent: number;         // Default: 40 (40% kitchen margin, divisor is 100 - vendorMarginPercent)
  platformMargins: {
    monthly: number;                   // Default: 4 (4% margin, divisor 0.96)
    weekly: number;                    // Default: 12 (12% margin, divisor 0.88)
    daily: number;                     // Default: 15 (15% margin, divisor 0.85)
  };
  roundingStrategy: 'round' | 'ceil';  // Default: 'round'
  updatedAt?: FirestoreTimestamp | any;
  updatedBy?: string;
}

export const DEFAULT_PRICING_ALGORITHM: PricingAlgorithmSettings = {
  deliveryChargePerMeal: 13,
  vendorMarginPercent: 40,
  platformMargins: {
    monthly: 4,
    weekly: 12,
    daily: 15,
  },
  roundingStrategy: 'round',
};

// ─── Meal Component Catalog & Customization ───────────────────────────────────

export type ComponentUnit = 'piece' | 'bowl' | 'portion';
export type ComponentCategory = 'staple' | 'curry' | 'side' | 'dessert';

export interface MealComponent {
  id: string;
  name: string;
  price: number; // Centrally controlled Admin price in ₹
  customerRate: number; // Aliased to price for backwards compatibility
  vendorRate: number;
  unit: ComponentUnit;
  baseQuantity: number;
  minQuantity: number;
  maxQuantity: number;
  rawCost?: number;
  isActive: boolean;
  category: ComponentCategory;
}

export interface CustomMealConfig {
  components: Record<string, number>; // componentId -> quantity
  deltaPricePerMeal: number;
  deltaVendorCostPerMeal?: number;
  customerDeltaPerMeal?: number;
  vendorDeltaPerMeal?: number;
  effectiveCustomerPricePerMeal: number;
  effectiveVendorCostPerMeal?: number;
  baseCustomerPricePerMeal: number;
  baseVendorCostPerMeal?: number;
  manifestSummary?: string;
  rawKitchenCost?: number;
  vendorMarginPercent?: number;
  vendorPayout?: number;
  algorithmicPricing?: any;
}

export const DEFAULT_MEAL_COMPONENTS: MealComponent[] = [
  {
    id: 'roti',
    name: 'Roti',
    price: 4,
    customerRate: 4,
    vendorRate: 3.25,
    unit: 'piece',
    baseQuantity: 4,
    minQuantity: 0,
    maxQuantity: 10,
    rawCost: 1.5,
    isActive: true,
    category: 'staple',
  },
  {
    id: 'rice',
    name: 'Rice',
    price: 18,
    customerRate: 18,
    vendorRate: 17.33,
    unit: 'bowl',
    baseQuantity: 1,
    minQuantity: 0,
    maxQuantity: 4,
    rawCost: 8.0,
    isActive: true,
    category: 'staple',
  },
  {
    id: 'dal',
    name: 'Dal',
    price: 16,
    customerRate: 16,
    vendorRate: 15.17,
    unit: 'bowl',
    baseQuantity: 1,
    minQuantity: 0,
    maxQuantity: 4,
    rawCost: 7.0,
    isActive: true,
    category: 'curry',
  },
  {
    id: 'sabji',
    name: 'Sabji',
    price: 20,
    customerRate: 20,
    vendorRate: 19.50,
    unit: 'bowl',
    baseQuantity: 1,
    minQuantity: 0,
    maxQuantity: 4,
    rawCost: 9.0,
    isActive: true,
    category: 'curry',
  },
  {
    id: 'salad',
    name: 'Salad',
    price: 11,
    customerRate: 11,
    vendorRate: 10.83,
    unit: 'portion',
    baseQuantity: 1,
    minQuantity: 0,
    maxQuantity: 3,
    rawCost: 5.0,
    isActive: true,
    category: 'side',
  },
  {
    id: 'paneer',
    name: 'Paneer Sabji',
    price: 32,
    customerRate: 32,
    vendorRate: 30.33,
    unit: 'bowl',
    baseQuantity: 0,
    minQuantity: 0,
    maxQuantity: 3,
    rawCost: 14.0,
    isActive: true,
    category: 'curry',
  },
  {
    id: 'curd',
    name: 'Curd / Raita',
    price: 14,
    customerRate: 14,
    vendorRate: 13.00,
    unit: 'portion',
    baseQuantity: 0,
    minQuantity: 0,
    maxQuantity: 3,
    rawCost: 6.0,
    isActive: true,
    category: 'side',
  },
  {
    id: 'curd_salad',
    name: 'Curd / Salad',
    price: 14,
    customerRate: 14,
    vendorRate: 13.00,
    unit: 'portion',
    baseQuantity: 0,
    minQuantity: 0,
    maxQuantity: 3,
    rawCost: 6.0,
    isActive: true,
    category: 'side',
  },
  {
    id: 'sweet',
    name: 'Chef Sweet',
    price: 18,
    customerRate: 18,
    vendorRate: 17.33,
    unit: 'piece',
    baseQuantity: 0,
    minQuantity: 0,
    maxQuantity: 5,
    rawCost: 8.0,
    isActive: true,
    category: 'dessert',
  },
];


// ─── Ambient globals for third-party scripts on `window` ─────────────────────
//
// Previously reached via `(window as any).X` at each call site. Declared once
// here so those reads are type-checked. Deliberately loose: these are external
// SDKs whose full surface we do not model, only the parts actually used.
//
// NOTE: this lives in index.ts, not a separate .d.ts, because a .d.ts sitting
// inside a package is not part of each app's tsconfig `include` — the
// declarations would simply never load. `declare global` inside a module that
// every app already imports does load.

export interface RazorpayCheckoutOptions {
  key: string;
  amount?: number;
  currency?: string;
  name?: string;
  description?: string;
  image?: string;
  order_id?: string;
  subscription_id?: string;
  handler?: (response: {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
  }) => void;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string | undefined>;
  theme?: { color?: string };
  modal?: { ondismiss?: () => void };
  [key: string]: unknown;
}

export interface RazorpayInstance {
  open(): void;
  on(event: string, handler: (...args: never[]) => void): void;
  close?(): void;
}

export interface RazorpayConstructor {
  new (options: RazorpayCheckoutOptions): RazorpayInstance;
}

declare global {
  interface Window {
    /** Injected by https://checkout.razorpay.com/v1/checkout.js */
    Razorpay?: RazorpayConstructor;
    /** Google Maps JS SDK `&callback=` target — see the admin delivery page. */
    initGoogleMap?: () => void;
  }
}
