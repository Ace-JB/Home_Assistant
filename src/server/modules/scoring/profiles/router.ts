import type { ScoringProfile } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

export const routerRuleProfile: ScoringProfile = {
  name: 'router.rule',
  gate: {
    mode: 'soft',
    temperature: 0.1,
  },
  thresholds: {
    minRelevance: 0.5,
    minConfidence: 0.5,
    hiddenBelow: 0.05,
    suppressedBelow: 0.25,
    hardRelevanceFloor: 0.15,
  },
  weights: {
    relevance: 0.5,
    base: 0.1,
    freshness: 0.1,
    feedback: 0.2,
    situation: 0.05,
    exploration: 0.05,
  },
  feedback: {
    priorMean: 0.5,
    priorStrength: 4,
    positiveWeight: 1,
    negativeWeight: 2,
    ignoredWeight: 0.5,
  },
  freshness: {
    halfLifeMs: 7 * DAY_MS,
    curve: 'exponential',
    unknownScore: 0.5,
  },
  exploration: {
    weight: 1,
  },
};
