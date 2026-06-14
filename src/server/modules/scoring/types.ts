export type ScoringVisibility = 'eligible' | 'suppressed' | 'hidden';
export type ScoringGateMode = 'hard' | 'soft' | 'bypass';
export type FreshnessCurve = 'exponential' | 'power' | 'linear';

export interface ScoringFreshnessInput {
  score?: number;
  createdAt?: number;
  lastSeenAt?: number;
  now?: number;
  halfLifeMs?: number;
  curve?: FreshnessCurve;
}

export interface ScoringFeedbackInput {
  positive?: number;
  negative?: number;
  ignored?: number;
}

export interface ScoringExplorationInput {
  impressions?: number;
}

export interface ScoringInput {
  baseScore: number;
  relevance: number;
  confidence: number;
  freshness?: ScoringFreshnessInput;
  feedback?: ScoringFeedbackInput;
  situation?: number;
  exploration?: ScoringExplorationInput;
}

export interface ScoringWeights {
  relevance: number;
  base: number;
  freshness: number;
  feedback: number;
  situation: number;
  exploration: number;
}

export interface ScoringThresholds {
  minRelevance: number;
  minConfidence: number;
  hiddenBelow: number;
  suppressedBelow: number;
  hardRelevanceFloor?: number;
}

export interface ScoringGateProfile {
  mode: ScoringGateMode;
  temperature: number;
}

export interface ScoringFeedbackProfile {
  priorMean: number;
  priorStrength: number;
  positiveWeight: number;
  negativeWeight: number;
  ignoredWeight: number;
}

export interface ScoringFreshnessProfile {
  halfLifeMs: number;
  curve: FreshnessCurve;
  unknownScore: number;
}

export interface ScoringExplorationProfile {
  weight: number;
}

export interface ScoringProfile {
  name: string;
  gate: ScoringGateProfile;
  thresholds: ScoringThresholds;
  weights: ScoringWeights;
  feedback: ScoringFeedbackProfile;
  freshness: ScoringFreshnessProfile;
  exploration: ScoringExplorationProfile;
}

export interface ScoringComponents {
  relevance: number;
  confidence: number;
  base: number;
  freshness: number;
  feedback: number;
  situation: number;
  exploration: number;
}

export interface ScoringResult {
  eligible: boolean;
  visibility: ScoringVisibility;
  finalScore: number;
  gateScore: number;
  rankScore: number;
  components: ScoringComponents;
  reasons: string[];
}
