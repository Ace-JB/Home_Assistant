import { clamp01 } from './kernel';
import type { ScoringFeedbackInput, ScoringFeedbackProfile } from './types';

function normalizeCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value!));
}

export function calculateFeedbackScore(input: ScoringFeedbackInput | undefined, profile: ScoringFeedbackProfile): number {
  const positive = normalizeCount(input?.positive);
  const negative = normalizeCount(input?.negative);
  const ignored = normalizeCount(input?.ignored);
  const priorStrength = Math.max(0, profile.priorStrength);
  const numerator = clamp01(profile.priorMean) * priorStrength + profile.positiveWeight * positive;
  const denominator = priorStrength
    + profile.positiveWeight * positive
    + profile.negativeWeight * negative
    + profile.ignoredWeight * ignored;

  if (denominator <= 0) return clamp01(profile.priorMean);
  return clamp01(numerator / denominator);
}

export function calculateExplorationBonus(impressions: number | undefined): number {
  if (!Number.isFinite(impressions)) return 1;
  return clamp01(1 / Math.sqrt(1 + Math.max(0, Math.trunc(impressions!))));
}
