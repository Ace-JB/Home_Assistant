export type VoiceAssetKind = 'speaker_prompt' | 'separated' | 'candidate' | 'benchmark' | 'cache' | 'validation';

export type VoiceAsset = {
  id: string;
  kind: VoiceAssetKind;
  path: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type VoiceSpeakerProfile = {
  speakerId: string;
  speakerName: string;
  promptList: string[];
  benchmarkResults: string[];
  cachedResponses: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type VoiceAssetIndex = {
  assets: VoiceAsset[];
  speakers: VoiceSpeakerProfile[];
  updatedAt: string;
};

export type VoiceAssetValidationNote = {
  speakerId: string;
  baselinePath?: string;
  separatedPath?: string;
  bestPromptPath?: string;
  baselineScore?: number;
  separatedScore?: number;
  bestPromptScore?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type VoicePromptCandidate = VoiceAsset & {
  kind: 'candidate';
  metadata: Record<string, unknown> & {
    durationMs?: number;
    speechRatio?: number;
    silenceRatio?: number;
    rmsStability?: number;
    pitchStability?: number;
    energyStability?: number;
    estimatedSnr?: number;
    emotionStability?: number;
    score?: number;
    transcript?: string;
    sourcePath?: string;
  };
};
