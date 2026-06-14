import type { FreshnessCurve, ScoringFreshnessInput, ScoringWeights } from './types';

export function clamp01(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value!));
}

export function normalizeUnitScore(value: number | undefined, max = 1): number {
  if (!Number.isFinite(value)) return 0;
  if (max <= 0) return clamp01(value);
  return clamp01(value! / max);
}

export function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

export function calculateFreshnessScore(input: ScoringFreshnessInput | undefined, defaults: {
  halfLifeMs: number;
  curve: FreshnessCurve;
  unknownScore: number;
}): number {
  if (input?.score !== undefined) return clamp01(input.score);

  const referenceAt = input?.lastSeenAt ?? input?.createdAt;
  if (!Number.isFinite(referenceAt)) return clamp01(defaults.unknownScore);

  const now = input?.now ?? Date.now();
  const halfLifeMs = input?.halfLifeMs ?? defaults.halfLifeMs;
  const ageMs = Math.max(0, now - referenceAt!);
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return ageMs === 0 ? 1 : 0;

  const curve = input?.curve ?? defaults.curve;
  if (curve === 'linear') {
    return clamp01(1 - ageMs / (halfLifeMs * 2));
  }
  if (curve === 'power') {
    return clamp01(1 / ((ageMs / halfLifeMs) + 1) ** 1.2);
  }
  return clamp01(0.5 ** (ageMs / halfLifeMs));
}

export function weightedSum(components: {
  relevance: number;
  base: number;
  freshness: number;
  feedback: number;
  situation: number;
  exploration: number;
}, weights: ScoringWeights): number {
  return clamp01(
    components.relevance * weights.relevance
    + components.base * weights.base
    + components.freshness * weights.freshness
    + components.feedback * weights.feedback
    + components.situation * weights.situation
    + components.exploration * weights.exploration,
  );
}
