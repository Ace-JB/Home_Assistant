import { clamp01, sigmoid } from './kernel';
import type { ScoringGateProfile, ScoringThresholds, ScoringVisibility } from './types';

export function calculateGateScore(input: {
  relevance: number;
  confidence: number;
}, gate: ScoringGateProfile, thresholds: ScoringThresholds): number {
  const relevance = clamp01(input.relevance);
  const confidence = clamp01(input.confidence);

  if (gate.mode === 'bypass') return 1;
  if (confidence < thresholds.minConfidence) return 0;
  if (thresholds.hardRelevanceFloor !== undefined && relevance < thresholds.hardRelevanceFloor) return 0;
  if (gate.mode === 'hard') return relevance >= thresholds.minRelevance ? 1 : 0;

  const temperature = Math.max(0.001, gate.temperature);
  return clamp01(sigmoid((relevance - thresholds.minRelevance) / temperature));
}

export function resolveVisibility(gateScore: number, thresholds: ScoringThresholds): ScoringVisibility {
  if (gateScore <= thresholds.hiddenBelow) return 'hidden';
  if (gateScore < thresholds.suppressedBelow) return 'suppressed';
  return 'eligible';
}
