import { describe, expect, test } from 'bun:test';
import { memoryAmbientProfile, memorySemanticProfile, scoreCandidate } from '@modules/scoring';

describe('Scoring engine', () => {
  test('hides candidates below the hard relevance gate', () => {
    const result = scoreCandidate({
      baseScore: 1,
      relevance: 0.1,
      confidence: 1,
      freshness: { score: 1 },
      feedback: {},
      situation: 0,
      exploration: { impressions: 0 },
    }, memorySemanticProfile);

    expect(result.eligible).toBe(false);
    expect(result.visibility).toBe('hidden');
    expect(result.gateScore).toBe(0);
    expect(result.finalScore).toBe(0);
  });

  test('soft gate midpoint compresses rank score before final scoring', () => {
    const result = scoreCandidate({
      baseScore: 1,
      relevance: 0.45,
      confidence: 1,
      freshness: { score: 1 },
      feedback: {},
      situation: 1,
      exploration: { impressions: 0 },
    }, memorySemanticProfile);

    expect(result.eligible).toBe(true);
    expect(result.gateScore).toBeCloseTo(0.5, 1);
    expect(result.finalScore).toBeLessThan(result.rankScore);
  });

  test('ranks eligible candidates with additive base freshness and feedback components', () => {
    const freshPositive = scoreCandidate({
      baseScore: 0.8,
      relevance: 0.9,
      confidence: 1,
      freshness: { score: 1 },
      feedback: { positive: 4, negative: 0, ignored: 0 },
      situation: 0.5,
      exploration: { impressions: 3 },
    }, memorySemanticProfile);
    const staleNeutral = scoreCandidate({
      baseScore: 0.8,
      relevance: 0.9,
      confidence: 1,
      freshness: { score: 0.2 },
      feedback: {},
      situation: 0.5,
      exploration: { impressions: 3 },
    }, memorySemanticProfile);

    expect(freshPositive.rankScore).toBeGreaterThan(staleNeutral.rankScore);
    expect(freshPositive.finalScore).toBeGreaterThan(staleNeutral.finalScore);
  });

  test('uses neutral freshness when freshness timestamps are unknown', () => {
    const result = scoreCandidate({
      baseScore: 1,
      relevance: 1,
      confidence: 1,
      feedback: {},
      situation: 0,
      exploration: { impressions: 0 },
    }, memorySemanticProfile);

    expect(result.components.freshness).toBe(0.5);
  });

  test('uses timestamp freshness instead of the unknown freshness default when dates exist', () => {
    const now = new Date('2026-06-12T00:00:00.000Z').getTime();
    const result = scoreCandidate({
      baseScore: 1,
      relevance: 1,
      confidence: 1,
      freshness: {
        createdAt: now - 30 * 24 * 60 * 60 * 1000,
        now,
      },
      feedback: {},
      situation: 0,
      exploration: { impressions: 0 },
    }, memorySemanticProfile);

    expect(result.components.freshness).toBeLessThan(1);
    expect(result.components.freshness).not.toBe(0.5);
  });

  test('starts feedback at neutral and weighs negative feedback more heavily than positive feedback', () => {
    const neutral = scoreCandidate({
      baseScore: 1,
      relevance: 1,
      confidence: 1,
      freshness: { score: 1 },
      feedback: {},
      situation: 0,
      exploration: { impressions: 0 },
    }, memorySemanticProfile);
    const positive = scoreCandidate({
      baseScore: 1,
      relevance: 1,
      confidence: 1,
      freshness: { score: 1 },
      feedback: { positive: 1, negative: 0, ignored: 0 },
      situation: 0,
      exploration: { impressions: 0 },
    }, memorySemanticProfile);
    const negative = scoreCandidate({
      baseScore: 1,
      relevance: 1,
      confidence: 1,
      freshness: { score: 1 },
      feedback: { positive: 1, negative: 1, ignored: 0 },
      situation: 0,
      exploration: { impressions: 0 },
    }, memorySemanticProfile);

    expect(neutral.components.feedback).toBe(0.5);
    expect(positive.components.feedback).toBeGreaterThan(neutral.components.feedback);
    expect(negative.components.feedback).toBeLessThan(neutral.components.feedback);
  });

  test('reduces exploration bonus as impressions grow', () => {
    const newCandidate = scoreCandidate({
      baseScore: 1,
      relevance: 1,
      confidence: 1,
      freshness: { score: 1 },
      feedback: {},
      situation: 0,
      exploration: { impressions: 0 },
    }, memorySemanticProfile);
    const exposedCandidate = scoreCandidate({
      baseScore: 1,
      relevance: 1,
      confidence: 1,
      freshness: { score: 1 },
      feedback: {},
      situation: 0,
      exploration: { impressions: 24 },
    }, memorySemanticProfile);

    expect(newCandidate.components.exploration).toBeGreaterThan(exposedCandidate.components.exploration);
  });

  test('ambient profile bypasses relevance gating for global preferences', () => {
    const result = scoreCandidate({
      baseScore: 0.8,
      relevance: 0,
      confidence: 1,
      freshness: { score: 0.7 },
      feedback: {},
      situation: 0,
      exploration: { impressions: 0 },
    }, memoryAmbientProfile);

    expect(result.eligible).toBe(true);
    expect(result.visibility).toBe('eligible');
    expect(result.gateScore).toBe(1);
    expect(result.finalScore).toBeGreaterThan(0);
  });
});
