import {
  calculateSubscriptionPrice,
  calculateStandardSubscriptionProduct,
  normalizeMarginRule,
  validateMarginRuleSet,
  resolveMarginRateForMeals,
  applyMarginRulesToRules,
  DEFAULT_PRICING_RULES,
  DEFAULT_ITEM_CATALOG,
  DEFAULT_STANDARD_MEAL,
  MarginRule,
  PricingRules,
  SubscriptionMealSlotInput,
} from '../pricingEngine';

describe('Dynamic Margin Rules (Quantity Tiers)', () => {
  const baseRules: PricingRules = { ...DEFAULT_PRICING_RULES };

  // Config A: three tiers tiling [1, ∞)
  const configA: MarginRule[] = [
    { id: 'tier_a', minMeals: 1, maxMeals: 9, marginRate: 0.15, isActive: true },
    { id: 'tier_b', minMeals: 10, maxMeals: 19, marginRate: 0.12, isActive: true },
    { id: 'tier_c', minMeals: 20, maxMeals: null, marginRate: 0.10, isActive: true },
  ];

  // Config B: two tiers
  const configB: MarginRule[] = [
    { id: 'low', minMeals: 1, maxMeals: 5, marginRate: 0.14, isActive: true },
    { id: 'high', minMeals: 6, maxMeals: null, marginRate: 0.09, isActive: true },
  ];

  // Config C: single open-ended tier
  const configC: MarginRule[] = [
    { id: 'flat', minMeals: 1, maxMeals: null, marginRate: 0.11, isActive: true },
  ];

  function scheduleOf(n: number): SubscriptionMealSlotInput[] {
    return Array.from({ length: n }, (_, i) => ({ dayKey: `d${i + 1}`, slot: 'lunch' as const }));
  }

  describe('normalizeMarginRule', () => {
    it('accepts a valid closed tier', () => {
      const r = normalizeMarginRule({ id: 'a', minMeals: 1, maxMeals: 9, marginRate: 0.13, isActive: true });
      expect(r).not.toBeNull();
      expect(r!.maxMeals).toBe(9);
      expect(r!.minMeals).toBe(1);
    });

    it('treats missing/null/empty maxMeals as open-ended', () => {
      expect(normalizeMarginRule({ id: 'b', minMeals: 10, maxMeals: null, marginRate: 0.1 })!.maxMeals).toBeNull();
      expect(normalizeMarginRule({ id: 'c', minMeals: 10, maxMeals: '', marginRate: 0.1 })!.maxMeals).toBeNull();
      expect(normalizeMarginRule({ id: 'd', minMeals: 10, marginRate: 0.1 })!.maxMeals).toBeNull();
    });

    it('rejects invalid ranges, non-integers, and out-of-bound margins', () => {
      expect(normalizeMarginRule({ minMeals: 0, marginRate: 0.1 })).toBeNull();
      expect(normalizeMarginRule({ minMeals: -1, marginRate: 0.1 })).toBeNull();
      expect(normalizeMarginRule({ minMeals: 5, maxMeals: 2, marginRate: 0.1 })).toBeNull();
      expect(normalizeMarginRule({ minMeals: 1.5, marginRate: 0.1 })).toBeNull();
      expect(normalizeMarginRule({ minMeals: 1, marginRate: 1 })).toBeNull();
      expect(normalizeMarginRule({ minMeals: 1, marginRate: 1.2 })).toBeNull();
      expect(normalizeMarginRule({ minMeals: 1, marginRate: -0.1 })).toBeNull();
      expect(normalizeMarginRule(null)).toBeNull();
      expect(normalizeMarginRule('nope')).toBeNull();
    });

    it('defaults isActive to true and generates an id when missing', () => {
      const r = normalizeMarginRule({ minMeals: 3, marginRate: 0.11 })!;
      expect(r.isActive).toBe(true);
      expect(typeof r.id).toBe('string');
      expect(r.id.length).toBeGreaterThan(0);
    });
  });

  describe('validateMarginRuleSet', () => {
    it('accepts an empty set (no tiering configured)', () => {
      expect(validateMarginRuleSet([])).toEqual([]);
    });

    it('accepts a fully-disabled set', () => {
      expect(
        validateMarginRuleSet([{ id: 'a', minMeals: 1, maxMeals: null, marginRate: 0.12, isActive: false }])
      ).toEqual([]);
    });

    it('accepts contiguous covered configurations A, B and C', () => {
      expect(validateMarginRuleSet(configA)).toEqual([]);
      expect(validateMarginRuleSet(configB)).toEqual([]);
      expect(validateMarginRuleSet(configC)).toEqual([]);
    });

    it('rejects a leading gap (first active tier not starting at 1 meal)', () => {
      const set: MarginRule[] = [
        { id: 'a', minMeals: 5, maxMeals: 10, marginRate: 0.13, isActive: true },
        { id: 'b', minMeals: 11, maxMeals: null, marginRate: 0.12, isActive: true },
      ];
      expect(validateMarginRuleSet(set).length).toBeGreaterThan(0);
    });

    it('rejects overlapping tiers', () => {
      const set: MarginRule[] = [
        { id: 'a', minMeals: 1, maxMeals: 10, marginRate: 0.13, isActive: true },
        { id: 'b', minMeals: 10, maxMeals: 20, marginRate: 0.12, isActive: true },
        { id: 'c', minMeals: 21, maxMeals: null, marginRate: 0.1, isActive: true },
      ];
      const errs = validateMarginRuleSet(set);
      expect(errs.some((e) => e.toLowerCase().includes('overlap'))).toBe(true);
    });

    it('rejects an uncovered gap between consecutive tiers', () => {
      const set: MarginRule[] = [
        { id: 'a', minMeals: 1, maxMeals: 9, marginRate: 0.13, isActive: true },
        { id: 'b', minMeals: 12, maxMeals: null, marginRate: 0.12, isActive: true },
      ];
      const errs = validateMarginRuleSet(set);
      expect(errs.some((e) => e.toLowerCase().includes('gap'))).toBe(true);
    });

    it('rejects a closed final tier (meal counts above the max uncovered)', () => {
      const set: MarginRule[] = [{ id: 'a', minMeals: 1, maxMeals: 20, marginRate: 0.13, isActive: true }];
      const errs = validateMarginRuleSet(set);
      expect(errs.some((e) => e.toLowerCase().includes('open-ended'))).toBe(true);
    });

    it('rejects multiple open-ended tiers', () => {
      const set: MarginRule[] = [
        { id: 'a', minMeals: 1, maxMeals: 5, marginRate: 0.13, isActive: true },
        { id: 'b', minMeals: 6, maxMeals: null, marginRate: 0.12, isActive: true },
        { id: 'c', minMeals: 7, maxMeals: null, marginRate: 0.1, isActive: true },
      ];
      const errs = validateMarginRuleSet(set);
      expect(errs.some((e) => e.toLowerCase().includes('open-ended'))).toBe(true);
    });

    it('rejects an open-ended tier that is not last', () => {
      const set: MarginRule[] = [
        { id: 'a', minMeals: 1, maxMeals: null, marginRate: 0.12, isActive: true },
        { id: 'b', minMeals: 5, maxMeals: 10, marginRate: 0.1, isActive: true },
      ];
      const errs = validateMarginRuleSet(set);
      expect(errs.length).toBeGreaterThan(0);
    });

    it('rejects duplicate ids and invalid margin rates', () => {
      const set: MarginRule[] = [
        { id: 'a', minMeals: 1, maxMeals: 5, marginRate: 0.13, isActive: true },
        { id: 'a', minMeals: 6, maxMeals: null, marginRate: 1, isActive: true },
      ];
      const errs = validateMarginRuleSet(set);
      expect(errs.some((e) => e.toLowerCase().includes('duplicate'))).toBe(true);
      expect(errs.some((e) => e.toLowerCase().includes('marginrate'))).toBe(true);
    });

    it('is aware of disabled tiers — a disabled tier leaves a gap', () => {
      const set: MarginRule[] = [
        { id: 'a', minMeals: 1, maxMeals: 9, marginRate: 0.13, isActive: true },
        { id: 'b', minMeals: 10, maxMeals: 19, marginRate: 0.12, isActive: false },
        { id: 'c', minMeals: 20, maxMeals: null, marginRate: 0.1, isActive: true },
      ];
      const errs = validateMarginRuleSet(set);
      expect(errs.some((e) => e.toLowerCase().includes('gap'))).toBe(true);
    });
  });

  describe('resolveMarginRateForMeals', () => {
    it('resolves rates inside, at boundaries, and past the open end', () => {
      expect(resolveMarginRateForMeals(configA, 1, 0.13).rate).toBe(0.15);
      expect(resolveMarginRateForMeals(configA, 9, 0.13).rate).toBe(0.15);
      expect(resolveMarginRateForMeals(configA, 10, 0.13).rate).toBe(0.12);
      expect(resolveMarginRateForMeals(configA, 19, 0.13).rate).toBe(0.12);
      expect(resolveMarginRateForMeals(configA, 20, 0.13).rate).toBe(0.10);
      expect(resolveMarginRateForMeals(configA, 1000, 0.13).rate).toBe(0.10);
      expect(resolveMarginRateForMeals(configA, 19999, 0.13).rate).toBe(0.10);
    });

    it('returns the fallback when no tiers are configured or the count is invalid', () => {
      expect(resolveMarginRateForMeals([], 13, 0.13).rate).toBe(0.13);
      expect(resolveMarginRateForMeals(undefined, 13, 0.13).rate).toBe(0.13);
      expect(resolveMarginRateForMeals(configA, 0, 0.13).rate).toBe(0.13);
    });

    it('records the matched rule id', () => {
      expect(resolveMarginRateForMeals(configA, 15, 0.13).ruleId).toBe('tier_b');
      expect(resolveMarginRateForMeals(configB, 3, 0.13).ruleId).toBe('low');
      expect(resolveMarginRateForMeals(configC, 500, 0.13).ruleId).toBe('flat');
      expect(resolveMarginRateForMeals([], 15, 0.13).ruleId).toBeNull();
    });

    it('ignores disabled tiers at resolution time (falls back inside the gap they leave)', () => {
      const set: MarginRule[] = [
        { id: 'a', minMeals: 1, maxMeals: 5, marginRate: 0.15, isActive: false },
        { id: 'b', minMeals: 6, maxMeals: null, marginRate: 0.09, isActive: true },
      ];
      // Count 6 is covered by the active tier -> 0.09 (the disabled tier no longer matches).
      expect(resolveMarginRateForMeals(set, 6, 0.13).rate).toBe(0.09);
      // Count 2 sits in the gap left by the disabled tier -> flat fallback.
      expect(resolveMarginRateForMeals(set, 2, 0.13).rate).toBe(0.13);
    });
  });

  describe('applyMarginRulesToRules', () => {
    it('returns an unchanged rules object when no tiers are configured', () => {
      const out = applyMarginRulesToRules(baseRules, undefined, 20);
      expect(out.margin).toBe(baseRules.margin);
      expect(out.appliedMarginRuleId).toBeUndefined();
      const out2 = applyMarginRulesToRules(baseRules, [], 20);
      expect(out2.margin).toBe(baseRules.margin);
    });

    it('overrides margin by meal count and records the applied tier id', () => {
      const out = applyMarginRulesToRules(baseRules, configA, 15);
      expect(out.margin).toBe(0.12);
      expect(out.appliedMarginRuleId).toBe('tier_b');
      expect(out.vendorDeduction).toBe(baseRules.vendorDeduction);
    });

    it('falls back when no tier matches the count', () => {
      expect(applyMarginRulesToRules(baseRules, configA, 0).margin).toBe(baseRules.margin);
    });
  });

  describe('Engine integration', () => {
    it('prices a 12-meal subscription with the tier-B margin and records it in the snapshot', () => {
      const res = calculateSubscriptionPrice(
        scheduleOf(12),
        DEFAULT_STANDARD_MEAL.itemQuantities,
        DEFAULT_ITEM_CATALOG,
        baseRules,
        configA
      );
      expect(res.totalMeals).toBe(12);
      expect(res.mealDetails.length).toBe(12);
      expect(res.pricingRules.margin).toBe(0.12);
      expect(res.pricingRules.appliedMarginRuleId).toBe('tier_b');
      expect(res.snapshot.marginRate).toBe(0.12);
      expect(res.snapshot.pricingRules.appliedMarginRuleId).toBe('tier_b');
    });

    it('produces identical prices whether tiered or configured as a flat equivalent margin', () => {
      const schedule = scheduleOf(12);
      const tiered = calculateSubscriptionPrice(schedule, DEFAULT_STANDARD_MEAL.itemQuantities, DEFAULT_ITEM_CATALOG, baseRules, configA);
      const flat = calculateSubscriptionPrice(schedule, DEFAULT_STANDARD_MEAL.itemQuantities, DEFAULT_ITEM_CATALOG, {
        ...baseRules,
        margin: 0.12,
      });
      expect(tiered.finalPrice).toBeCloseTo(flat.finalPrice, 2);
      expect(tiered.margin).toBeCloseTo(flat.margin, 2);
    });

    it('applies the open-ended tier to large subscriptions', () => {
      const res = calculateSubscriptionPrice(
        scheduleOf(60),
        DEFAULT_STANDARD_MEAL.itemQuantities,
        DEFAULT_ITEM_CATALOG,
        baseRules,
        configA
      );
      expect(res.pricingRules.margin).toBe(0.10);
      expect(res.pricingRules.appliedMarginRuleId).toBe('tier_c');
    });

    it('falls back to the flat margin when tiers are empty or disabled', () => {
      const schedule = scheduleOf(5);
      const res = calculateSubscriptionPrice(schedule, DEFAULT_STANDARD_MEAL.itemQuantities, DEFAULT_ITEM_CATALOG, baseRules, []);
      expect(res.pricingRules.margin).toBe(baseRules.margin);
      expect(res.pricingRules.appliedMarginRuleId).toBeUndefined();
    });

    it('treats both-slots days as two meals for margin resolution', () => {
      const schedule: SubscriptionMealSlotInput[] = [
        { dayKey: 'mon', slot: 'both' },
        { dayKey: 'tue', slot: 'both' },
        { dayKey: 'wed', slot: 'both' },
        { dayKey: 'thu', slot: 'both' },
        { dayKey: 'fri', slot: 'both' },
      ];
      // 10 meals -> tier_b (10-19) in configA
      const res = calculateSubscriptionPrice(schedule, DEFAULT_STANDARD_MEAL.itemQuantities, DEFAULT_ITEM_CATALOG, baseRules, configA);
      expect(res.totalMeals).toBe(10);
      expect(res.pricingRules.margin).toBe(0.12);
      expect(res.pricingRules.appliedMarginRuleId).toBe('tier_b');
    });

    it('resolves the standard product snapshot margin by totalMeals', () => {
      const res = calculateStandardSubscriptionProduct(12, baseRules, configA);
      expect(res.snapshot.pricingRules.appliedMarginRuleId).toBe('tier_b');
      expect(res.snapshot.marginRate).toBe(0.12);
      const big = calculateStandardSubscriptionProduct(30, baseRules, configA);
      expect(big.snapshot.marginRate).toBe(0.10);
    });
  });
});