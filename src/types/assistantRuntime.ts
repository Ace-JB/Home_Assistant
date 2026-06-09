export type AssistantRuntimeStatusValue = 'stopped' | 'starting' | 'running' | 'stopping' | 'degraded' | 'error';
export type AssistantRuntimeMode = 'minimal' | 'full';
export type AssistantRuntimeAction = 'start' | 'stop';
export type AssistantRuntimeOptionalService = 'cosyvoice' | 'live-vision' | 'voice-separation';
export type AssistantRuntimeTaskStatus = 'pending' | 'running' | 'ready' | 'failed' | 'skipped' | 'stopping' | 'stopped';
export type AssistantRuntimeOperationPhase = 'running' | 'completed' | 'failed';

export type AssistantRuntimeTask = {
  id: 'assistant-runtime' | 'funasr' | 'audio-monitor' | 'realtime-socket' | 'webrtc' | 'live-vision' | 'cosyvoice' | 'voice-separation';
  label: string;
  group: 'core' | 'optional';
  status: AssistantRuntimeTaskStatus;
  required: boolean;
  selected: boolean;
  message?: string;
};

export type AssistantRuntimeOperation = {
  type: 'start' | 'stop';
  phase: AssistantRuntimeOperationPhase;
  tasks: AssistantRuntimeTask[];
};

export type AssistantRuntimeStartInput = {
  mode?: AssistantRuntimeMode;
  optionalServices?: AssistantRuntimeOptionalService[];
};

export type AssistantRuntimeServiceState = {
  id: 'monitor' | 'realtime-socket' | 'webrtc' | 'python-services';
  status: AssistantRuntimeStatusValue;
  message: string | null;
};

export type AssistantRuntimeStatus = {
  status: AssistantRuntimeStatusValue;
  mode: AssistantRuntimeMode;
  activeMode: AssistantRuntimeMode | null;
  startedAt: number | null;
  uptimeSeconds: number | null;
  lastError: string | null;
  degradedReasons: string[];
  actions: AssistantRuntimeAction[];
  services: AssistantRuntimeServiceState[];
  tasks: AssistantRuntimeTask[];
  operation: AssistantRuntimeOperation | null;
};

export const DEFAULT_ASSISTANT_RUNTIME_STATUS: AssistantRuntimeStatus = {
  status: 'stopped',
  mode: 'minimal',
  activeMode: null,
  startedAt: null,
  uptimeSeconds: null,
  lastError: null,
  degradedReasons: [],
  actions: ['start'],
  services: [
    { id: 'monitor', status: 'stopped', message: null },
    { id: 'realtime-socket', status: 'stopped', message: null },
    { id: 'webrtc', status: 'stopped', message: null },
    { id: 'python-services', status: 'stopped', message: null },
  ],
  tasks: [
    { id: 'assistant-runtime', label: 'Assistant Runtime', group: 'core', status: 'pending', required: true, selected: true },
    { id: 'funasr', label: 'Voice ASR / FunASR', group: 'core', status: 'pending', required: true, selected: true },
    { id: 'audio-monitor', label: 'Audio Monitor / Wake ASR', group: 'core', status: 'pending', required: true, selected: true },
    { id: 'realtime-socket', label: 'Realtime Socket', group: 'core', status: 'pending', required: true, selected: true },
    { id: 'cosyvoice', label: 'CosyVoice TTS', group: 'optional', status: 'skipped', required: false, selected: false },
    { id: 'live-vision', label: 'Live / Vision', group: 'optional', status: 'skipped', required: false, selected: false },
    { id: 'webrtc', label: 'WebRTC Stream', group: 'optional', status: 'skipped', required: false, selected: false },
    { id: 'voice-separation', label: 'MDX Voice Separation', group: 'optional', status: 'skipped', required: false, selected: false },
  ],
  operation: null,
};

export function isAssistantRuntimeAvailable(status: AssistantRuntimeStatus | AssistantRuntimeStatusValue): boolean {
  const value = typeof status === 'string' ? status : status.status;
  return value === 'running' || value === 'degraded';
}
