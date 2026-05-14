// src/modules/face-engine.ts
import * as tf from '@tensorflow/tfjs-node';
import { Human, type Config } from '@vladmandic/human'; //[cite: 1]
import { db } from '@db/index';
import { GLOBAL_CONFIG } from '@/global_config';
import { readFileSync } from 'fs';
import path from 'path';

const MODEL_DIR = path.join(process.cwd(), GLOBAL_CONFIG.MODELS.METADATA_DIR);

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
  faces: FaceDetection[];
  bodies: BodyDetection[];
  hands: HandDetection[];
  objects: ObjectDetection[];
  ts: number;
};

class FaceEngine {
  private isLoaded = false;
  private human!: Human;
  // Human 配置对象
  private humanConfig: Partial<Config> = {
    backend: 'webgl',
    modelBasePath: `file://${MODEL_DIR}`, // 指向本地模型文件夹
    face: {
      enabled: true,
      detector: { return: true, rotation: true },
      mesh: { enabled: true }, // 提供更精准的特征点
      iris: { enabled: true }, // 可选：视线追踪
      description: { enabled: true }, // 必须开启以提取特征向量
      emotion: { enabled: true }, // 开启情绪识别，关闭后可避免加载相关模型
    },
    // 针对 Apple Silicon 的优化
    softwareKernels: false,
    body: { enabled: true },
    hand: { enabled: true },
    object: { enabled: true },
  };

  constructor() {
    // 初始化 Human 实例
    this.human = new Human(this.humanConfig);
  }

  private loadPromise: Promise<void> | null = null;

  private findBestMatch(descriptor: number[] | Float32Array, records: FaceRecord[]): FaceMatch {
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestSimilarity = 0;
    let candidateLabel: string | null = null;
    const comparableDescriptor = Array.from(descriptor);

    for (const record of records) {
      const dist = this.human.match.distance(comparableDescriptor, record.descriptor);
      const similarity = this.human.match.similarity(comparableDescriptor, record.descriptor);
      if (similarity > bestSimilarity || (similarity === bestSimilarity && dist < bestDistance)) {
        bestDistance = dist;
        bestSimilarity = similarity;
        candidateLabel = record.name;
      }
    }

    const matched = candidateLabel !== null && bestSimilarity >= GLOBAL_CONFIG.FACE.DISTANCE_THRESHOLD;

    return {
      label: matched ? candidateLabel! : '未知陌生人',
      distance: Number.isFinite(bestDistance) ? bestDistance : 1.0,
      similarity: bestSimilarity,
      matched,
      candidateLabel,
    };
  }

  async loadModels() {
    if (this.isLoaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      await tf.ready();
      console.log(`🚀 TensorFlow Accelerator: ${tf.getBackend().toUpperCase()}`);

      try {
        // 预加载模型并进行热身
        await this.human.load();
        await this.human.warmup();
        this.isLoaded = true;
        console.log('✅ Human 感知引擎加载成功');
      } catch (error) {
        console.error('❌ 模型加载失败:', error);
        throw error;
      } finally {
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }

  // 核心工具：提取特征描述符 (Embedding)
  async extractDescriptor(imageSource: string | Buffer): Promise<Float32Array | null> {
    if (!this.isLoaded) await this.loadModels();

    let buffer: Buffer = typeof imageSource === 'string' ? readFileSync(imageSource) : imageSource;
    const tensor = tf.node.decodeImage(buffer, 3);

    // 使用 human.detect 替代 face-api 的方法
    const result = await this.human.detect(tensor);
    tf.dispose(tensor);

    // 返回第一个检测到的人脸特征向量
    if (result.face && result.face.length > 0) {
      return result.face[0]!.embedding ? new Float32Array(result.face[0]!.embedding) : null;
    }
    return null;
  }

  // 识别逻辑：寻找库中最匹配的成员
  async identify(descriptor_to_compare: number[]): Promise<string> {

    const records = db.getRecords();
    if (records.length === 0) return '数据库为空';

    return this.findBestMatch(descriptor_to_compare, records).label;
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
  async detectAll(imageBuffer: Buffer): Promise<HumanDetectionResult> {
    if (!this.isLoaded) await this.loadModels();

    const tensor = tf.node.decodeImage(imageBuffer, 3);
    const result = await this.human.detect(tensor as any);
    tf.dispose(tensor);

    const records = db.getRecords();

    // --- 人脸识别 ---
    const faces: FaceDetection[] = (result.face ?? []).map(f => {
      let match: FaceMatch = {
        label: '未知陌生人', distance: 1.0, similarity: 0, matched: false, candidateLabel: null,
      };
      if (f.embedding && records.length > 0) {
        match = this.findBestMatch(f.embedding, records);
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
        threshold: GLOBAL_CONFIG.FACE.DISTANCE_THRESHOLD,
        emotions,
        box: { x: f.box[0], y: f.box[1], width: f.box[2], height: f.box[3] },
      };
    });

    // --- 肢体姿态 ---
    const bodies: BodyDetection[] = (result.body ?? []).map((b: any) => ({
      score: Number((b.score ?? 0).toFixed(3)),
      keypointCount: b.keypoints?.length ?? 0,
      box: { x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] },
    }));

    // --- 手部追踪 ---
    const hands: HandDetection[] = (result.hand ?? []).map((h: any) => ({
      score: Number((h.score ?? 0).toFixed(3)),
      handedness: h.handedness ?? 'unknown',
      gestures: Array.isArray(h.gesture)
        ? h.gesture.map((g: any) => (typeof g === 'string' ? g : (g.name ?? String(g)))).filter(Boolean)
        : [],
      box: { x: h.box[0], y: h.box[1], width: h.box[2], height: h.box[3] },
    }));

    // --- 物体检测 ---
    const objects: ObjectDetection[] = (result.object ?? []).map((o: any) => ({
      label: String(o.label ?? 'unknown'),
      score: Number((o.score ?? 0).toFixed(3)),
      box: { x: o.box[0], y: o.box[1], width: o.box[2], height: o.box[3] },
    }));

    return { faces, bodies, hands, objects, ts: Date.now() };
  }

  // 向后兼容：仅返回人脸识别结果（内部委托给 detectAll）
  async recognizeFaces(imageBuffer: Buffer): Promise<RecognizedFace[]> {
    const detection = await this.detectAll(imageBuffer);
    return detection.faces;
  }
}

export const faceEngine = new FaceEngine();
