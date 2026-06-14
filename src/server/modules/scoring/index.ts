import { calculateFeedbackScore, calculateExplorationBonus } from './feedback';
import { calculateGateScore, resolveVisibility } from './gates';
import { calculateFreshnessScore, clamp01, normalizeUnitScore, weightedSum } from './kernel';
import type { ScoringInput, ScoringProfile, ScoringResult } from './types';

export { memoryAmbientProfile, memorySemanticProfile } from './profiles/memory';
export { routerRuleProfile } from './profiles/router';
export type * from './types';

export function scoreCandidate(input: ScoringInput, profile: ScoringProfile): ScoringResult {
  const components = {
    relevance: clamp01(input.relevance),
    confidence: clamp01(input.confidence),
    base: input.baseScore > 1 ? normalizeUnitScore(input.baseScore, 5) : clamp01(input.baseScore),
    freshness: calculateFreshnessScore(input.freshness, profile.freshness),
    feedback: calculateFeedbackScore(input.feedback, profile.feedback),
    situation: clamp01(input.situation),
    exploration: calculateExplorationBonus(input.exploration?.impressions) * profile.exploration.weight,
  };
  const gateScore = calculateGateScore(components, profile.gate, profile.thresholds);
  const visibility = resolveVisibility(gateScore, profile.thresholds);
  const rankScore = weightedSum(components, profile.weights);
  const finalScore = visibility === 'hidden' ? 0 : clamp01(gateScore * rankScore);
  const eligible = visibility !== 'hidden';

  return {
    eligible,
    visibility,
    finalScore,
    gateScore,
    rankScore,
    components,
    reasons: buildReasons(profile.name, visibility, components.relevance, components.confidence),
  };
}

function buildReasons(profileName: string, visibility: string, relevance: number, confidence: number): string[] {
  return [
    `profile=${profileName}`,
    `visibility=${visibility}`,
    `relevance=${Number(relevance.toFixed(3))}`,
    `confidence=${Number(confidence.toFixed(3))}`,
  ];
}
