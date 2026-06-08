export const VISION_PROFILES = ['identity', 'perception', 'full'] as const;

export type VisionProfile = typeof VISION_PROFILES[number];

export function isVisionProfile(value: unknown): value is VisionProfile {
  return typeof value === 'string' && (VISION_PROFILES as readonly string[]).includes(value);
}
