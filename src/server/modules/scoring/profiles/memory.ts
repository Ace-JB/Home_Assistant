import type { ScoringProfile } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

export const memorySemanticProfile: ScoringProfile = {
  name: 'memory.semantic',
  gate: {
    mode: 'soft',
    temperature: 0.08,
  },
  thresholds: {
    minRelevance: 0.45,
    minConfidence: 0.55,
    hiddenBelow: 0.05,
    suppressedBelow: 0.25,
    hardRelevanceFloor: 0.2,
  },
  weights: {
    relevance: 0.35,
    base: 0.14,
    freshness: 0.26,
    feedback: 0.16,
    situation: 0.07,
    exploration: 0.02,
  },
  feedback: {
    priorMean: 0.5,
    priorStrength: 4,
    positiveWeight: 1,
    negativeWeight: 2,
    ignoredWeight: 0.5,
  },
  freshness: {
    halfLifeMs: 30 * DAY_MS,
    curve: 'power',
    unknownScore: 0.5,
  },
  exploration: {
    weight: 1,
  },
};

export const memoryAmbientProfile: ScoringProfile = {
  ...memorySemanticProfile,
  name: 'memory.ambient',
  gate: {
    mode: 'bypass',
    temperature: 0.08,
  },
  thresholds: {
    ...memorySemanticProfile.thresholds,
    minRelevance: 0,
    hardRelevanceFloor: 0,
  },
  weights: {
    ...memorySemanticProfile.weights,
    relevance: 0,
    base: 0.34,
    freshness: 0.24,
    feedback: 0.28,
    situation: 0.08,
    exploration: 0.06,
  },
};
