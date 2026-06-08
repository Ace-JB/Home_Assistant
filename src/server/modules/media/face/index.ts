// src/modules/face-engine.ts
import * as tf from '@tensorflow/tfjs-node';
import { Human, type Config } from '@vladmandic/human'; //[cite: 1]
import { db } from '@db/index';
import { GLOBAL_CONFIG } from '@/global_config';
import { readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { VisionProfile } from '@/shared/vision/types';

const MODEL_DIR = path.resolve(GLOBAL_CONFIG.MODELS.METADATA_DIR);

type FaceRecord = {
  name: string;
  descriptor: number[];
};

type FaceMatch = {
  label: string;
  distance: number;
  similarity: number;
  matched: boolean;
  candidateLabel: string | null;
};

export type RecognizedFace = {
  label: string;
  matched: boolean;
  distance: number | null;
  similarity: number | null;
  candidateLabel: string | null;
  threshold: number;
  box: { x: number; y: number; width: number; height: number };
};

export type EmotionScore = { emotion: string; score: number };

/** RecognizedFace + top-3 emotion scores from Human */
export type FaceDetection = RecognizedFace & {
  emotions: EmotionScore[];
};

export type BodyDetection = {
  score: number;
  keypointCount: number;
  box: { x: number; y: number; width: number; height: number };
};

export type HandDetection = {
  score: number;
  handedness: string;
  gestures: string[];
  box: { x: number; y: number; width: number; height: number };
};

export type ObjectDetection = {
  label: string;
  score: number;
  box: { x: number; y: number; width: number; height: number };
};

/** Full output of one Human.detect() call across all enabled modules */
export type HumanDetectionResult = {
  profile: VisionProfile;
  requestedProfile: VisionProfile;
  degraded: boolean;
  degradeReason?: string;
  faces: FaceDetection[];
  bodies: BodyDetection[];
  hands: HandDetection[];
  objects: ObjectDetection[];
  ts: number;
};

type HumanEngineState = {
  profile: VisionProfile;
  human: Human;
  isLoaded: boolean;
  loadPromise: Promise<void> | null;
  lastUsedAt: number;
  runningCount: number;
  releasedAt: number | null;
};

type DetectOptions = {
  allowDegraded?: boolean;
};

export type VisionProfileCleanupResult = {
  profile: VisionProfile;
  action: 'released' | 'skipped';
  reason: 'identity' | 'active_request' | 'active_profile' | 'not_loaded' | 'loading' | 'running' | 'not_idle' | 'released' | 'release_failed';
  idleMs: number;
  releaseMode?: 'models.reset';
  error?: string;
};

type CleanupIdleProfilesInput = {
  now?: number;
  idleTtlMs: number;
  activeProfile: VisionProfile;
  hasActiveRequest: boolean;
};

const PROFILE_ORDER: VisionProfile[] = ['identity', 'perception', 'full'];
const PROFILE_RANK: Record<VisionProfile, number> = {
  identity: 0,
  perception: 1,
  full: 2,
};

class FaceEngine {
  private engines = new Map<VisionProfile, HumanEngineState>();

  __setEngineForTest(profile: VisionProfile, state: Partial<HumanEngineState> = {}): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('__setEngineForTest is only available in test environment');
    }
    const human = state.human ?? new Human(this.createConfig(profile));
    this.engines.set(profile, {
      profile,
      human,
      isLoaded: state.isLoaded ?? true,
      loadPromise: state.loadPromise ?? null,
      lastUsedAt: state.lastUsedAt ?? Date.now(),
      runningCount: state.runningCount ?? 0,
      releasedAt: state.releasedAt ?? null,
    });
  }

  __hasEngineForTest(profile: VisionProfile): boolean {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('__hasEngineForTest is only available in test environment');
    }
    return this.engines.has(profile);
  }

  private findBestMatch(human: Human, descriptor: number[] | Float32Array, records: FaceRecord[]): FaceMatch {
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestSimilarity = 0;
    let candidateLabel: string | null = null;
    const comparableDescriptor = Array.from(descriptor);

    for (const record of records) {
      const dist = human.match.distance(comparableDescriptor, record.descriptor);
      const similarity = human.match.similarity(comparableDescriptor, record.descriptor);
      if (similarity > bestSimilarity || (similarity === bestSimilarity && dist < bestDistance)) {
        bestDistance = dist;
        bestSimilarity = similarity;
        candidateLabel = record.name;
      }
    }

    const matched = candidateLabel !== null && bestSimilarity >= GLOBAL_CONFIG.FACE.SIMILARITY_THRESHOLD;

    return {
      label: matched ? candidateLabel! : '未知陌生人',
      distance: Number.isFinite(bestDistance) ? bestDistance : 1.0,
      similarity: bestSimilarity,
      matched,
      candidateLabel,
    };
  }

  private createConfig(profile: VisionProfile): Partial<Config> {
    const includeEmotion = profile !== 'identity';
    const includePerception = profile === 'perception' || profile === 'full';
    const includeFull = profile === 'full';

    return {
      backend: 'webgl',
      modelBasePath: pathToFileURL(MODEL_DIR).href, // 指向本地模型文件夹
      face: {
        enabled: true,
        detector: { return: true, rotation: true },
        mesh: { enabled: includeFull },
        iris: { enabled: includeFull },
        description: { enabled: true },
        emotion: { enabled: includeEmotion },
      },
      softwareKernels: false,
      body: { enabled: includePerception },
      hand: { enabled: includePerception },
      object: { enabled: includeFull },
    };
  }

  private getEngine(profile: VisionProfile): HumanEngineState {
    const existing = this.engines.get(profile);
    if (existing) return existing;

    const engine: HumanEngineState = {
      profile,
      human: new Human(this.createConfig(profile)),
      isLoaded: false,
      loadPromise: null,
      lastUsedAt: Date.now(),
      runningCount: 0,
      releasedAt: null,
    };
    this.engines.set(profile, engine);
    return engine;
  }

  private async loadProfile(profile: VisionProfile): Promise<void> {
    const engine = this.getEngine(profile);
    if (engine.isLoaded) return;
    if (engine.loadPromise) return engine.loadPromise;

    engine.loadPromise = (async () => {
      await tf.ready();
      console.log(`🚀 TensorFlow Accelerator: ${tf.getBackend().toUpperCase()}`);

      try {
        await engine.human.load();
        await engine.human.warmup();
        engine.isLoaded = true;
        console.log(`✅ Human 感知引擎加载成功 (${profile})`);
      } catch (error) {
        console.error(`❌ 模型加载失败 (${profile}):`, error);
        throw error;
      } finally {
        engine.loadPromise = null;
      }
    })();

    return engine.loadPromise;
  }

  private findBestLoadedFallback(profile: VisionProfile): VisionProfile | null {
    for (let rank = PROFILE_RANK[profile]; rank >= 0; rank--) {
      const candidate = PROFILE_ORDER[rank];
      if (candidate && this.engines.get(candidate)?.isLoaded) {
        return candidate;
      }
    }
    return null;
  }

  async loadModels(profile: VisionProfile = 'identity') {
    await this.loadProfile(profile);
  }

  prewarm(profile: VisionProfile): void {
    void this.loadProfile(profile).catch((error) => {
      console.warn(`[Vision] Human ${profile} prewarm failed:`, error);
    });
  }

  cleanupIdleProfiles(input: CleanupIdleProfilesInput): VisionProfileCleanupResult[] {
    const now = input.now ?? Date.now();
    const idleTtlMs = Math.max(0, input.idleTtlMs);
    const results: VisionProfileCleanupResult[] = [];

    for (const profile of PROFILE_ORDER) {
      const engine = this.engines.get(profile);
      const idleMs = engine ? Math.max(0, now - engine.lastUsedAt) : 0;
      if (profile === 'identity') {
        results.push({ profile, action: 'skipped', reason: 'identity', idleMs });
        continue;
      }
      if (input.hasActiveRequest) {
        results.push({ profile, action: 'skipped', reason: 'active_request', idleMs });
        continue;
      }
      if (profile === input.activeProfile) {
        results.push({ profile, action: 'skipped', reason: 'active_profile', idleMs });
        continue;
      }
      if (!engine || !engine.isLoaded) {
        results.push({ profile, action: 'skipped', reason: 'not_loaded', idleMs });
        continue;
      }
      if (engine.loadPromise) {
        results.push({ profile, action: 'skipped', reason: 'loading', idleMs });
        continue;
      }
      if (engine.runningCount > 0) {
        results.push({ profile, action: 'skipped', reason: 'running', idleMs });
        continue;
      }
      if (idleMs < idleTtlMs) {
        results.push({ profile, action: 'skipped', reason: 'not_idle', idleMs });
        continue;
      }

      try {
        engine.human.models.reset();
        engine.releasedAt = now;
        this.engines.delete(profile);
        results.push({ profile, action: 'released', reason: 'released', idleMs, releaseMode: 'models.reset' });
      } catch (error) {
        results.push({
          profile,
          action: 'skipped',
          reason: 'release_failed',
          idleMs,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  // 核心工具：提取特征描述符 (Embedding)
  async extractDescriptor(imageSource: string | Buffer): Promise<Float32Array | null> {
    await this.loadProfile('identity');
    const engine = this.getEngine('identity');

    let buffer: Buffer = typeof imageSource === 'string' ? readFileSync(imageSource) : imageSource;
    const tensor = tf.node.decodeImage(buffer, 3);
    engine.runningCount += 1;
    engine.lastUsedAt = Date.now();
    try {
      // 使用 human.detect 替代 face-api 的方法
      const result = await engine.human.detect(tensor);

      // 返回第一个检测到的人脸特征向量
      if (result.face && result.face.length > 0) {
        return result.face[0]!.embedding ? new Float32Array(result.face[0]!.embedding) : null;
      }
      return null;
    } finally {
      engine.runningCount = Math.max(0, engine.runningCount - 1);
      engine.lastUsedAt = Date.now();
      tf.dispose(tensor);
    }
  }

  // 识别逻辑：寻找库中最匹配的成员
  async identify(descriptor_to_compare: number[]): Promise<string> {
    await this.loadProfile('identity');
    const engine = this.getEngine('identity');

    const records = db.getRecords();
    if (records.length === 0) return '数据库为空';

    return this.findBestMatch(engine.human, descriptor_to_compare, records).label;
  }

  async registerUser(name: string, imagePath: string): Promise<Float32Array | null> {
    console.log(`⏳ 正在分析照片 ${imagePath}...`);
    const descriptor = await this.extractDescriptor(imagePath);
    if (descriptor) {
      db.save(name, descriptor);
      return descriptor;
    }
    return null;
  }

  // 完整感知检测：人脸 + 肢体 + 手部 + 物体（单次 human.detect 调用）
  async detect(
    imageBuffer: Buffer,
    requestedProfile: VisionProfile = 'identity',
    options: DetectOptions = {},
  ): Promise<HumanDetectionResult> {
    let profile = requestedProfile;
    let degraded = false;
    let degradeReason: string | undefined;
    const requestedEngine = this.getEngine(requestedProfile);

    if (!requestedEngine.isLoaded) {
      if (options.allowDegraded) {
        this.prewarm(requestedProfile);
        const fallback = this.findBestLoadedFallback(requestedProfile);
        if (fallback) {
          profile = fallback;
          degraded = fallback !== requestedProfile;
          degradeReason = degraded ? `${requestedProfile}_not_ready` : undefined;
        } else {
          await this.loadProfile(requestedProfile);
        }
      } else {
        await this.loadProfile(requestedProfile);
      }
    }

    const engine = this.getEngine(profile);
    if (!engine.isLoaded) {
      await this.loadProfile(profile);
    }

    const tensor = tf.node.decodeImage(imageBuffer, 3);
    engine.runningCount += 1;
    engine.lastUsedAt = Date.now();
    try {
      const result = await engine.human.detect(tensor as any);
      const records = db.getRecords();

      // --- 人脸识别 ---
      const faces: FaceDetection[] = (result.face ?? []).map(f => {
        let match: FaceMatch = {
          label: '未知陌生人', distance: 1.0, similarity: 0, matched: false, candidateLabel: null,
        };
        if (f.embedding && records.length > 0) {
          match = this.findBestMatch(engine.human, f.embedding, records);
        }

        const emotions: EmotionScore[] = ((f as any).emotion ?? [])
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, 3)
          .map((e: any) => ({ emotion: e.emotion, score: Number(e.score.toFixed(3)) }));

        return {
          label: match.label,
          matched: match.matched,
          distance: match.candidateLabel ? match.distance : null,
          similarity: match.candidateLabel ? match.similarity : null,
          candidateLabel: match.candidateLabel,
          threshold: GLOBAL_CONFIG.FACE.SIMILARITY_THRESHOLD,
          emotions: profile === 'identity' ? [] : emotions,
          box: { x: f.box[0], y: f.box[1], width: f.box[2], height: f.box[3] },
        };
      });

      // --- 肢体姿态 ---
      const bodies: BodyDetection[] = profile === 'identity'
        ? []
        : (result.body ?? []).map((b: any) => ({
          score: Number((b.score ?? 0).toFixed(3)),
          keypointCount: b.keypoints?.length ?? 0,
          box: { x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] },
        }));

      // --- 手部追踪 ---
      const hands: HandDetection[] = profile === 'identity'
        ? []
        : (result.hand ?? []).map((h: any) => ({
          score: Number((h.score ?? 0).toFixed(3)),
          handedness: h.handedness ?? 'unknown',
          gestures: Array.isArray(h.gesture)
            ? h.gesture.map((g: any) => (typeof g === 'string' ? g : (g.name ?? String(g)))).filter(Boolean)
            : [],
          box: { x: h.box[0], y: h.box[1], width: h.box[2], height: h.box[3] },
        }));

      // --- 物体检测 ---
      const objects: ObjectDetection[] = profile === 'full'
        ? (result.object ?? []).map((o: any) => ({
          label: String(o.label ?? 'unknown'),
          score: Number((o.score ?? 0).toFixed(3)),
          box: { x: o.box[0], y: o.box[1], width: o.box[2], height: o.box[3] },
        }))
        : [];

      return {
        profile,
        requestedProfile,
        degraded,
        ...(degradeReason ? { degradeReason } : {}),
        faces,
        bodies,
        hands,
        objects,
        ts: Date.now(),
      };
    } finally {
      engine.runningCount = Math.max(0, engine.runningCount - 1);
      engine.lastUsedAt = Date.now();
      tf.dispose(tensor);
    }
  }

  async detectAll(imageBuffer: Buffer): Promise<HumanDetectionResult> {
    return this.detect(imageBuffer, 'full');
  }

}

export const faceEngine = new FaceEngine();
