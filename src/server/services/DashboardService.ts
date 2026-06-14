import { spawn } from 'child_process';
import { execFile } from 'child_process';
import { loadavg } from 'os';
import { promisify } from 'util';
import si, { type Systeminformation } from 'systeminformation';
import { GLOBAL_CONFIG } from '@/global_config';
import { funasrService } from '@/server/services/FunASRService';
import { checkCosyVoiceService, getYtDlpStatus } from '@/server/services/CosyVoiceMaterialService';
import { mdxSeparationService } from '@/server/services/voice-assets/MdxSeparationService';
import {
  getAssistantRuntimeService,
  getAssistantRuntimeServiceIfInitialized,
  type AssistantRuntimeServiceState,
  type AssistantRuntimeStatus,
  type AssistantRuntimeTask,
} from '@/server/services/AssistantRuntimeService';

export type DashboardServiceStatus = 'running' | 'starting' | 'stopping' | 'stopped' | 'degraded' | 'error' | 'unknown';
export type DashboardInterfaceStatus = 'ok' | 'failed' | 'unknown';
export type DashboardRecommendationLevel = 'info' | 'warning' | 'critical';

export type DashboardLogEntry = {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
};

export type DashboardServiceInterface = {
  label: string;
  url: string;
  status: DashboardInterfaceStatus;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
};

export type DashboardServiceItem = {
  id: string;
  name: string;
  status: DashboardServiceStatus;
  controllable: boolean;
  controlReason: string | null;
  pid: number | null;
  resources: {
    cpuPercent: number | null;
    memoryMb: number | null;
    uptimeSeconds: number | null;
  };
  interfaces: DashboardServiceInterface[];
  logsAvailable: boolean;
  actions: Array<'start' | 'stop'>;
  lastError: string | null;
};

export type DashboardServiceGroup = {
  id: 'primary' | 'advanced';
  title: string;
  collapsed: boolean;
  services: DashboardServiceItem[];
};

export type DashboardStatus = {
  system: {
    cpuPercent: number | null;
    loadAverage: number[];
    memory: {
      totalMb: number;
      usedMb: number;
      freeMb: number;
      usedPercent: number;
    };
    process: {
      pid: number;
      memoryMb: number;
      uptimeSeconds: number;
    };
    uptimeSeconds: number;
    platform: {
      name: string;
      release: string;
      arch: string;
      hostname?: string;
      distro?: string;
    };
    cpu: {
      brand: string;
      cores: number;
      physicalCores: number;
      speedGhz: number | null;
    };
    gpu: {
      available: boolean;
      status: 'available' | 'unsupported';
      detail: string;
      controllers: Array<{
        model: string;
        vendor: string;
        vramMb: number | null;
        utilizationGpu: number | null;
        temperatureGpu: number | null;
      }>;
    };
  };
  services: DashboardServiceItem[];
  serviceGroups: DashboardServiceGroup[];
  recommendations: Array<{
    level: DashboardRecommendationLevel;
    title: string;
    detail: string;
    serviceId?: string;
  }>;
};

type DashboardMetrics = {
  currentLoad: Systeminformation.CurrentLoadData | null;
  cpu: Systeminformation.CpuData | null;
  graphics: Systeminformation.GraphicsData | null;
  mem: Systeminformation.MemData | null;
  osInfo: Systeminformation.OsData | null;
  processes: Systeminformation.ProcessesData | null;
  macMemory: MacMemorySnapshot | null;
  macProcesses: Map<number, MacProcessSnapshot>;
  time: Systeminformation.TimeData;
};

type MacMemorySnapshot = {
  totalMb: number;
  usedMb: number;
  freeMb: number;
};

type MacProcessSnapshot = {
  pid: number;
  cpuPercent: number | null;
  memoryMb: number | null;
  uptimeSeconds: number | null;
};

const SERVICE_IDS = new Set(['main', 'assistant-runtime', 'voice-asr', 'live-vision', 'realtime-socket', 'webrtc', 'monitor', 'funasr', 'cosyvoice', 'voice-separation', 'qwen-vlm', 'qwen-router', 'ffmpeg', 'yt-dlp']);
const STOPPED_ASSISTANT_RUNTIME: AssistantRuntimeStatus = {
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
    { id: 'qwen-router', label: 'Qwen Router Model', group: 'core', status: 'pending', required: true, selected: true },
    { id: 'qwen-vlm', label: 'Qwen Main Model', group: 'core', status: 'pending', required: true, selected: true },
    { id: 'audio-monitor', label: 'Audio Monitor / Wake ASR', group: 'core', status: 'pending', required: true, selected: true },
    { id: 'realtime-socket', label: 'Realtime Socket', group: 'core', status: 'pending', required: true, selected: true },
    { id: 'cosyvoice', label: 'CosyVoice TTS', group: 'optional', status: 'skipped', required: false, selected: false },
    { id: 'live-vision', label: 'Live / Vision', group: 'optional', status: 'skipped', required: false, selected: false },
    { id: 'webrtc', label: 'WebRTC Stream', group: 'optional', status: 'skipped', required: false, selected: false },
    { id: 'voice-separation', label: 'MDX Voice Separation', group: 'optional', status: 'skipped', required: false, selected: false },
  ],
  operation: null,
};
const dashboardLogs = new Map<string, DashboardLogEntry[]>();
const execFileAsync = promisify(execFile);
let cosyVoiceStarting = false;
let cosyVoiceLastError: string | null = null;

export async function getDashboardStatus(): Promise<DashboardStatus> {
  const metrics = await collectDashboardMetrics();
  const assistantRuntime = getAssistantRuntimeSnapshot();
  const [cosyVoice, ytDlp] = await Promise.all([
    getCosyVoiceDashboardStatus(metrics),
    getYtDlpDashboardStatus(),
  ]);
  const [qwenVlm, qwenRouter] = await Promise.all([
    getQwenModelDashboardStatus(metrics, 'qwen-vlm'),
    getQwenModelDashboardStatus(metrics, 'qwen-router'),
  ]);
  const funasr = getFunAsrDashboardStatus(metrics);
  const main = getMainServiceStatus(metrics);
  const assistant = getAssistantRuntimeDashboardStatus(metrics, assistantRuntime);
  const realtimeSocket = getRealtimeSocketStatus(metrics, assistantRuntime);
  const webRtc = getWebRtcStatus(metrics, assistantRuntime);
  const monitor = getMonitorStatus(metrics, assistantRuntime);
  const voiceAsr = getVoiceAsrDashboardStatus(metrics, assistantRuntime, funasr, monitor);
  const liveVision = getLiveVisionDashboardStatus(metrics, assistantRuntime, monitor, webRtc);
  const primaryServices = [
    main,
    assistant,
    voiceAsr,
    liveVision,
  ];
  const advancedServices = [
    qwenVlm,
    qwenRouter,
    cosyVoice,
    getVoiceSeparationDashboardStatus(metrics),
    getFfmpegStatus(),
    ytDlp,
    realtimeSocket,
    webRtc,
  ];
  const services = [
    ...primaryServices,
    ...advancedServices,
    monitor,
    funasr,
  ];

  return {
    system: getSystemStatus(metrics),
    services,
    serviceGroups: [
      { id: 'primary', title: 'Core Services', collapsed: false, services: primaryServices },
      { id: 'advanced', title: 'Advanced Dependencies', collapsed: true, services: advancedServices },
    ],
    recommendations: buildRecommendations(services),
  };
}

export async function startDashboardService(serviceId: string): Promise<DashboardServiceItem> {
  assertKnownService(serviceId);
  if (serviceId === 'assistant-runtime') {
    appendLog('assistant-runtime', 'info', 'Start requested from dashboard');
    const status = await getAssistantRuntimeService().start();
    return getAssistantRuntimeDashboardStatus(await collectDashboardMetrics(), status);
  }
  if (serviceId === 'funasr') {
    appendLog('funasr', 'info', 'Start requested from dashboard');
    await funasrService.start();
    return getFunAsrDashboardStatus(await collectDashboardMetrics());
  }
  if (serviceId === 'cosyvoice') {
    await startManagedCosyVoice();
    return getCosyVoiceDashboardStatus(await collectDashboardMetrics());
  }
  if (serviceId === 'voice-separation') {
    await mdxSeparationService.start();
    return getVoiceSeparationDashboardStatus(await collectDashboardMetrics());
  }
  if (serviceId === 'qwen-vlm' || serviceId === 'qwen-router') {
    await startManagedModelService(serviceId);
    return getQwenModelDashboardStatus(await collectDashboardMetrics(), serviceId);
  }
  throw new Error(`Service ${serviceId} is read-only from dashboard.`);
}

export async function stopDashboardService(serviceId: string): Promise<DashboardServiceItem> {
  assertKnownService(serviceId);
  if (serviceId === 'assistant-runtime') {
    appendLog('assistant-runtime', 'info', 'Stop requested from dashboard');
    const status = await getAssistantRuntimeService().stop();
    return getAssistantRuntimeDashboardStatus(await collectDashboardMetrics(), status);
  }
  if (serviceId === 'funasr') {
    appendLog('funasr', 'info', 'Stop requested from dashboard');
    await funasrService.stop();
    return getFunAsrDashboardStatus(await collectDashboardMetrics());
  }
  if (serviceId === 'cosyvoice') {
    await stopManagedCosyVoice();
    return getCosyVoiceDashboardStatus(await collectDashboardMetrics());
  }
  if (serviceId === 'voice-separation') {
    await mdxSeparationService.stop();
    return getVoiceSeparationDashboardStatus(await collectDashboardMetrics());
  }
  if (serviceId === 'qwen-vlm' || serviceId === 'qwen-router') {
    await stopManagedModelService(serviceId);
    return getQwenModelDashboardStatus(await collectDashboardMetrics(), serviceId);
  }
  throw new Error(`Service ${serviceId} is read-only from dashboard.`);
}

export type StopAllDashboardManagedServicesDeps = {
  stopFunASR?: () => Promise<void>;
  stopModelServices?: () => Promise<void>;
  stopCosyVoice?: () => Promise<void>;
  stopMdx?: () => Promise<void>;
};

export type StartAllDashboardManagedServicesDeps = {
  startFunASR?: () => Promise<void>;
  startModelServices?: () => Promise<void>;
  startCosyVoice?: () => Promise<void>;
  startMdx?: () => Promise<void>;
};

export async function startDashboardManagedFunASR(): Promise<void> {
  appendLog('funasr', 'info', 'Start requested by assistant runtime');
  await funasrService.start();
}

export async function startDashboardManagedModelServices(): Promise<void> {
  await startDashboardManagedRouterModel();
  await startDashboardManagedMainModel();
}

export async function startDashboardManagedRouterModel(): Promise<void> {
  appendLog('qwen-router', 'info', 'Start requested by assistant runtime');
  await startManagedModelService('qwen-router');
}

export async function startDashboardManagedMainModel(): Promise<void> {
  appendLog('qwen-vlm', 'info', 'Start requested by assistant runtime');
  await startManagedModelService('qwen-vlm');
}

export async function startDashboardManagedCosyVoice(): Promise<void> {
  await startManagedCosyVoice();
}

export async function startDashboardManagedVoiceSeparation(): Promise<void> {
  appendLog('voice-separation', 'info', 'Start requested by assistant runtime');
  await mdxSeparationService.start();
}

export async function startAllDashboardManagedServices(deps?: StartAllDashboardManagedServicesDeps): Promise<void> {
  const tasks = deps
    ? [
      ['funasr', deps.startFunASR],
      ['qwen-router/qwen-vlm', deps.startModelServices],
      ['cosyvoice', deps.startCosyVoice],
      ['voice-separation', deps.startMdx],
    ] as const
    : [
      ['funasr', () => funasrService.start()],
      ['qwen-router/qwen-vlm', startDashboardManagedModelServices],
      ['cosyvoice', startManagedCosyVoice],
      ['voice-separation', () => mdxSeparationService.start()],
    ] as const;

  appendLog('main', 'info', 'Starting all assistant runtime Python services...');
  const failures: string[] = [];
  for (const [serviceId, start] of tasks) {
    if (!start) return;
    appendLog(serviceId, 'info', 'Start requested by assistant runtime');
    try {
      await start();
    } catch (error) {
      failures.push(`${serviceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

export async function stopAllDashboardManagedServices(deps?: StopAllDashboardManagedServicesDeps): Promise<void> {
  if (deps) {
    await deps.stopFunASR?.();
    await deps.stopModelServices?.();
    await deps.stopCosyVoice?.();
    await deps.stopMdx?.();
    return;
  }

  appendLog('main', 'info', 'Stopping all dashboard-managed Python services...');
  await runPythonServiceManager(['stop', 'all']);
  cosyVoiceStarting = false;
}

export function getDashboardServiceLogs(serviceId: string, limit = 200): DashboardLogEntry[] {
  assertKnownService(serviceId);
  if (serviceId === 'funasr') {
    return mergeLogs(funasrService.getLogs(limit), dashboardLogs.get('funasr') ?? [], limit);
  }
  if (serviceId === 'voice-separation') {
    return mergeLogs(mdxSeparationService.getLogs(limit), dashboardLogs.get('voice-separation') ?? [], limit);
  }
  return (dashboardLogs.get(serviceId) ?? []).slice(-normalizeLimit(limit));
}

function getSystemStatus(metrics: DashboardMetrics): DashboardStatus['system'] {
  const memory = process.memoryUsage();
  const totalMb = metrics.macMemory?.totalMb ?? bytesToMb(metrics.mem?.total ?? 0);
  const freeMb = metrics.macMemory?.freeMb ?? bytesToMb(metrics.mem?.available ?? metrics.mem?.free ?? 0);
  const usedMb = metrics.macMemory?.usedMb ?? Math.max(0, totalMb - freeMb);
  const gpuControllers = metrics.graphics?.controllers ?? [];
  return {
    cpuPercent: metrics.currentLoad ? round(metrics.currentLoad.currentLoad, 1) : null,
    loadAverage: loadavg().map(value => round(value, 2)),
    memory: {
      totalMb,
      usedMb,
      freeMb,
      usedPercent: totalMb > 0 ? round((usedMb / totalMb) * 100, 1) : 0,
    },
    process: {
      pid: process.pid,
      memoryMb: metrics.macProcesses.get(process.pid)?.memoryMb ?? bytesToMb(memory.rss),
      uptimeSeconds: Math.floor(process.uptime()),
    },
    uptimeSeconds: Math.floor(metrics.time.uptime),
    platform: {
      name: metrics.osInfo?.platform ?? process.platform,
      release: metrics.osInfo?.release ?? '',
      arch: metrics.osInfo?.arch ?? process.arch,
      hostname: metrics.osInfo?.hostname,
      distro: metrics.osInfo?.distro,
    },
    cpu: {
      brand: metrics.cpu?.brand ?? 'Unknown CPU',
      cores: metrics.cpu?.cores ?? 0,
      physicalCores: metrics.cpu?.physicalCores ?? 0,
      speedGhz: typeof metrics.cpu?.speed === 'number' ? metrics.cpu.speed : null,
    },
    gpu: {
      available: gpuControllers.length > 0,
      status: gpuControllers.length > 0 ? 'available' : 'unsupported',
      detail: gpuControllers.length > 0
        ? gpuControllers.map(controller => controller.model || controller.vendor || 'GPU').join(', ')
        : 'GPU metrics require platform support or an external exporter.',
      controllers: gpuControllers.map(controller => ({
        model: controller.model || controller.name || 'GPU',
        vendor: controller.vendor || '',
        vramMb: typeof controller.vram === 'number' ? controller.vram : null,
        utilizationGpu: typeof controller.utilizationGpu === 'number' ? round(controller.utilizationGpu, 1) : null,
        temperatureGpu: typeof controller.temperatureGpu === 'number' ? round(controller.temperatureGpu, 1) : null,
      })),
    },
  };
}

function getMainServiceStatus(metrics: DashboardMetrics): DashboardServiceItem {
  const processInfo = getProcessSnapshot(metrics, process.pid);
  return {
    id: 'main',
    name: 'Bun API Server',
    status: 'running',
    controllable: false,
    controlReason: 'Main process cannot safely stop itself from the dashboard.',
    pid: process.pid,
    resources: {
      cpuPercent: processInfo.cpuPercent,
      memoryMb: processInfo.memoryMb ?? bytesToMb(process.memoryUsage().rss),
      uptimeSeconds: processInfo.uptimeSeconds ?? Math.floor(process.uptime()),
    },
    interfaces: [{
      label: 'HTTP',
      url: `http://localhost:${GLOBAL_CONFIG.SERVER.PORT}/`,
      status: 'ok',
      statusCode: 200,
      latencyMs: null,
      error: null,
    }],
    logsAvailable: false,
    actions: [],
    lastError: null,
  };
}

function getAssistantRuntimeDashboardStatus(metrics: DashboardMetrics, runtime: AssistantRuntimeStatus): DashboardServiceItem {
  const processInfo = getProcessSnapshot(metrics, process.pid);
  const running = runtime.status === 'running' || runtime.status === 'degraded' || runtime.status === 'starting' || runtime.status === 'stopping';
  const detail = runtime.activeMode
    ? `mode=${runtime.activeMode}`
    : 'Assistant runtime is offline until started from the dashboard.';
  return {
    id: 'assistant-runtime',
    name: 'Assistant Runtime',
    status: runtime.status,
    controllable: true,
    controlReason: null,
    pid: running ? process.pid : null,
    resources: {
      cpuPercent: running ? processInfo.cpuPercent : null,
      memoryMb: running ? processInfo.memoryMb : null,
      uptimeSeconds: runtime.uptimeSeconds,
    },
    interfaces: [{
      label: 'Runtime control',
      url: '/api/assistant-runtime/status',
      status: runtime.status === 'error' ? 'failed' : 'ok',
      statusCode: null,
      latencyMs: null,
      error: runtime.lastError ?? (runtime.degradedReasons.length > 0 ? runtime.degradedReasons.join('; ') : detail),
    }],
    logsAvailable: true,
    actions: runtime.actions,
    lastError: runtime.lastError ?? (runtime.degradedReasons.length > 0 ? runtime.degradedReasons.join('; ') : null),
  };
}

function getRealtimeSocketStatus(metrics: DashboardMetrics, runtime: AssistantRuntimeStatus): DashboardServiceItem {
  const processInfo = getProcessSnapshot(metrics, process.pid);
  const state = getRuntimeOwnedService(runtime, 'realtime-socket');
  const running = state.status === 'running' || state.status === 'degraded' || state.status === 'starting' || state.status === 'stopping';
  return {
    id: 'realtime-socket',
    name: 'Realtime Socket',
    status: toDashboardStatus(state.status),
    controllable: false,
    controlReason: 'Realtime socket is owned by the monitor/main server lifecycle.',
    pid: running ? process.pid : null,
    resources: {
      cpuPercent: running ? processInfo.cpuPercent : null,
      memoryMb: running ? processInfo.memoryMb : null,
      uptimeSeconds: running ? processInfo.uptimeSeconds ?? Math.floor(process.uptime()) : null,
    },
    interfaces: [{
      label: 'WebSocket',
      url: `ws://localhost:${GLOBAL_CONFIG.SERVER.SOCKET_PORT}/ws/realtime`,
      status: running ? 'unknown' : 'failed',
      statusCode: null,
      latencyMs: null,
      error: running ? 'WebSocket upgrade is not probed by dashboard polling.' : 'Assistant runtime is stopped.',
    }],
    logsAvailable: false,
    actions: [],
    lastError: state.message,
  };
}

function getWebRtcStatus(metrics: DashboardMetrics, runtime: AssistantRuntimeStatus): DashboardServiceItem {
  const state = getRuntimeOwnedService(runtime, 'webrtc');
  const ffmpeg = findProcessByName(metrics, 'ffmpeg');
  const processInfo = getProcessSnapshot(metrics, ffmpeg?.pid);
  const running = state.status === 'running' || state.status === 'degraded' || state.status === 'starting' || state.status === 'stopping';
  return {
    id: 'webrtc',
    name: 'WebRTC Stream',
    status: toDashboardStatus(state.status),
    controllable: false,
    controlReason: 'WebRTC stream starts and stops with browser signaling sessions.',
    pid: ffmpeg?.pid ?? null,
    resources: {
      cpuPercent: processInfo.cpuPercent,
      memoryMb: processInfo.memoryMb,
      uptimeSeconds: processInfo.uptimeSeconds,
    },
    interfaces: [{
      label: 'Signaling',
      url: `ws://localhost:${GLOBAL_CONFIG.SERVER.PORT}/webrtc`,
      status: running ? 'unknown' : 'failed',
      statusCode: null,
      latencyMs: null,
      error: running ? 'Waiting for a browser WebRTC session.' : 'Assistant runtime is stopped.',
    }],
    logsAvailable: false,
    actions: [],
    lastError: state.message,
  };
}

function getMonitorStatus(metrics: DashboardMetrics, runtime: AssistantRuntimeStatus): DashboardServiceItem {
  const processInfo = getProcessSnapshot(metrics, process.pid);
  const state = getRuntimeOwnedService(runtime, 'monitor');
  const running = state.status === 'running' || state.status === 'degraded' || state.status === 'starting' || state.status === 'stopping';
  return {
    id: 'monitor',
    name: 'Sentinel Monitor',
    status: toDashboardStatus(state.status),
    controllable: false,
    controlReason: 'Camera and microphone loops are coupled to the assistant runtime.',
    pid: running ? process.pid : null,
    resources: {
      cpuPercent: running ? processInfo.cpuPercent : null,
      memoryMb: running ? processInfo.memoryMb : null,
      uptimeSeconds: running ? processInfo.uptimeSeconds ?? Math.floor(process.uptime()) : null,
    },
    interfaces: [
      { label: 'Camera', url: `avfoundation:${GLOBAL_CONFIG.VIDEO.DEVICE}`, status: running ? 'unknown' : 'failed', statusCode: null, latencyMs: null, error: running ? 'Hardware stream health is reported in live monitor.' : 'Assistant runtime is stopped.' },
      { label: 'Microphone', url: `avfoundation:${GLOBAL_CONFIG.VOICE.DEVICE}`, status: running ? 'unknown' : 'failed', statusCode: null, latencyMs: null, error: running ? 'Hardware stream health is reported in live monitor.' : 'Assistant runtime is stopped.' },
    ],
    logsAvailable: false,
    actions: [],
    lastError: state.message,
  };
}

function getVoiceAsrDashboardStatus(
  metrics: DashboardMetrics,
  runtime: AssistantRuntimeStatus,
  funasr: DashboardServiceItem,
  monitor: DashboardServiceItem,
): DashboardServiceItem {
  const audioTask = getRuntimeTask(runtime, 'audio-monitor');
  const funasrTask = getRuntimeTask(runtime, 'funasr');
  const status = aggregateProductStatus(runtime, [funasrTask?.status, audioTask?.status], [funasr.status, monitor.status]);
  const processInfo = getProcessSnapshot(metrics, process.pid);
  const running = status === 'running' || status === 'degraded' || status === 'starting' || status === 'stopping';
  const taskError = [funasrTask, audioTask].map(task => task?.message).find(Boolean) ?? null;

  return {
    id: 'voice-asr',
    name: 'Voice ASR',
    status,
    controllable: false,
    controlReason: 'Voice ASR is started by the Assistant Runtime minimal profile.',
    pid: running ? process.pid : null,
    resources: {
      cpuPercent: running ? processInfo.cpuPercent : null,
      memoryMb: running ? processInfo.memoryMb : null,
      uptimeSeconds: running ? runtime.uptimeSeconds : null,
    },
    interfaces: [
      ...funasr.interfaces,
      ...monitor.interfaces.filter(item => item.label === 'Microphone'),
    ],
    logsAvailable: funasr.logsAvailable,
    actions: [],
    lastError: taskError ?? funasr.lastError ?? monitor.lastError,
  };
}

function getLiveVisionDashboardStatus(
  metrics: DashboardMetrics,
  runtime: AssistantRuntimeStatus,
  monitor: DashboardServiceItem,
  webRtc: DashboardServiceItem,
): DashboardServiceItem {
  const liveTask = getRuntimeTask(runtime, 'live-vision');
  const webRtcTask = getRuntimeTask(runtime, 'webrtc');
  const status = aggregateProductStatus(runtime, [liveTask?.status, webRtcTask?.status], [monitor.status, webRtc.status]);
  const processInfo = getProcessSnapshot(metrics, process.pid);
  const running = status === 'running' || status === 'degraded' || status === 'starting' || status === 'stopping';
  const taskError = [liveTask, webRtcTask].map(task => task?.message).find(Boolean) ?? null;

  return {
    id: 'live-vision',
    name: 'Live / Vision',
    status,
    controllable: false,
    controlReason: 'Live video and vision detection are optional startup tools.',
    pid: running ? process.pid : null,
    resources: {
      cpuPercent: running ? processInfo.cpuPercent : null,
      memoryMb: running ? processInfo.memoryMb : null,
      uptimeSeconds: running ? runtime.uptimeSeconds : null,
    },
    interfaces: [
      ...monitor.interfaces.filter(item => item.label === 'Camera'),
      ...webRtc.interfaces,
    ],
    logsAvailable: false,
    actions: [],
    lastError: taskError ?? monitor.lastError ?? webRtc.lastError,
  };
}

function getFunAsrDashboardStatus(metrics: DashboardMetrics): DashboardServiceItem {
  const status = funasrService.getStatus();
  const processInfo = getProcessSnapshot(metrics, status.pid);
  const serviceStatus: DashboardServiceStatus = status.ready ? 'running' : status.starting ? 'starting' : status.lastError ? 'error' : 'stopped';
  return {
    id: 'funasr',
    name: 'FunASR',
    status: serviceStatus,
    controllable: true,
    controlReason: null,
    pid: status.pid,
    resources: {
      cpuPercent: processInfo.cpuPercent,
      memoryMb: processInfo.memoryMb,
      uptimeSeconds: status.uptimeSeconds ?? processInfo.uptimeSeconds,
    },
    interfaces: [{
      label: 'HTTP',
      url: status.url,
      status: status.ready ? 'ok' : status.starting ? 'unknown' : 'failed',
      statusCode: null,
      latencyMs: null,
      error: status.lastError,
    }],
    logsAvailable: true,
    actions: status.ready || status.starting ? ['stop'] : ['start'],
    lastError: status.lastError,
  };
}

async function getCosyVoiceDashboardStatus(metrics: DashboardMetrics): Promise<DashboardServiceItem> {
  const service = await checkCosyVoiceService();
  const systemProcessInfo = findProcessByCommand(metrics, 'cosyvoice_service')
    ?? findProcessByCommand(metrics, 'cosyvoice_run');
  const processInfo = getProcessSnapshot(metrics, systemProcessInfo?.pid);
  const status: DashboardServiceStatus = cosyVoiceStarting
    ? 'starting'
    : service.ok
      ? 'running'
      : cosyVoiceLastError
        ? 'error'
        : 'stopped';

  return {
    id: 'cosyvoice',
    name: 'CosyVoice MLX',
    status,
    controllable: true,
    controlReason: null,
    pid: systemProcessInfo?.pid ?? null,
    resources: {
      cpuPercent: processInfo.cpuPercent,
      memoryMb: processInfo.memoryMb,
      uptimeSeconds: processInfo.uptimeSeconds,
    },
    interfaces: [{
      label: 'TTS endpoint',
      url: service.url,
      status: service.ok ? 'ok' : 'failed',
      statusCode: service.status,
      latencyMs: null,
      error: service.error,
    }],
    logsAvailable: true,
    actions: service.ok ? ['stop'] : (!cosyVoiceStarting ? ['start'] : []),
    lastError: cosyVoiceLastError ?? service.error,
  };
}

function getVoiceSeparationDashboardStatus(metrics: DashboardMetrics): DashboardServiceItem {
  const status = mdxSeparationService.getStatus();
  const processInfo = getProcessSnapshot(metrics, status.pid);
  const dashboardStatus: DashboardServiceStatus = status.status === 'ready' || status.status === 'busy'
    ? 'running'
    : status.status === 'starting'
      ? 'starting'
      : status.status === 'disabled'
        ? 'stopped'
        : status.status === 'error'
          ? 'error'
          : 'stopped';
  return {
    id: 'voice-separation',
    name: 'MDX-Net Separation',
    status: dashboardStatus,
    controllable: status.enabled,
    controlReason: status.enabled ? 'Optional lazy worker; prompt import starts it on demand.' : 'Voice separation is disabled by VOICE_SEPARATION_ENABLED.',
    pid: status.pid,
    resources: {
      cpuPercent: processInfo.cpuPercent,
      memoryMb: processInfo.memoryMb,
      uptimeSeconds: status.uptimeSeconds ?? processInfo.uptimeSeconds,
    },
    interfaces: [{
      label: 'HTTP',
      url: status.url,
      status: status.ready ? 'ok' : status.lastError ? 'failed' : 'unknown',
      statusCode: null,
      latencyMs: null,
      error: status.lastError,
    }],
    logsAvailable: true,
    actions: status.ready || status.status === 'starting' || status.status === 'busy' ? ['stop'] : status.enabled ? ['start'] : [],
    lastError: status.lastError,
  };
}

type QwenModelServiceId = 'qwen-vlm' | 'qwen-router';

async function getQwenModelDashboardStatus(metrics: DashboardMetrics, serviceId: QwenModelServiceId): Promise<DashboardServiceItem> {
  const service = await checkQwenModelService(serviceId);
  const processInfo = getProcessSnapshot(metrics, service.pid);
  const status: DashboardServiceStatus = service.ready
    ? 'running'
    : service.error
      ? 'error'
      : 'stopped';
  const name = serviceId === 'qwen-vlm' ? 'Qwen VLM MLX' : 'Qwen Router MLX';
  return {
    id: serviceId,
    name,
    status,
    controllable: true,
    controlReason: null,
    pid: service.pid,
    resources: {
      cpuPercent: processInfo.cpuPercent,
      memoryMb: processInfo.memoryMb,
      uptimeSeconds: service.uptimeSeconds ?? processInfo.uptimeSeconds,
    },
    interfaces: [{
      label: 'HTTP',
      url: service.url,
      status: service.ready ? 'ok' : service.error ? 'failed' : 'unknown',
      statusCode: service.status,
      latencyMs: service.latencyMs,
      error: service.error,
    }],
    logsAvailable: true,
    actions: service.ready ? ['stop'] : ['start'],
    lastError: service.error,
  };
}

async function startManagedModelService(serviceId: QwenModelServiceId): Promise<void> {
  const health = await checkQwenModelService(serviceId);
  if (health.ready) {
    appendLog(serviceId, 'info', `${serviceId} already online at ${health.url}.`);
    return;
  }
  appendLog(serviceId, 'info', `Starting ${serviceId}...`);
  await runPythonServiceManager(['start', serviceId]);
  await postModelServiceStart(serviceId);
  await waitForModelServiceReady(serviceId);
}

async function stopManagedModelService(serviceId: QwenModelServiceId): Promise<void> {
  appendLog(serviceId, 'info', `Stopping ${serviceId}...`);
  await fetch(new URL('/stop', withTrailingSlash(getQwenModelServiceBaseUrl(serviceId))), {
    method: 'POST',
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
  await runPythonServiceManager(['stop', serviceId]);
}

async function waitForModelServiceReady(serviceId: QwenModelServiceId): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = GLOBAL_CONFIG.MODEL_SERVICES.REQUEST_TIMEOUT_MS;
  while (Date.now() - startedAt < timeoutMs) {
    const health = await checkQwenModelService(serviceId);
    if (health.ready) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  throw new Error(`${serviceId} startup timeout (${Math.round(timeoutMs / 1000)}s)`);
}

async function postModelServiceStart(serviceId: QwenModelServiceId): Promise<void> {
  const response = await fetch(new URL('/start', withTrailingSlash(getQwenModelServiceBaseUrl(serviceId))), {
    method: 'POST',
    signal: AbortSignal.timeout(GLOBAL_CONFIG.MODEL_SERVICES.REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${serviceId} start failed status=${response.status}${detail ? ` detail=${detail.slice(0, 300)}` : ''}`);
  }
}

async function checkQwenModelService(serviceId: QwenModelServiceId): Promise<{
  url: string;
  ready: boolean;
  status: number | null;
  latencyMs: number | null;
  pid: number | null;
  uptimeSeconds: number | null;
  error: string | null;
}> {
  const baseUrl = getQwenModelServiceBaseUrl(serviceId);
  const healthUrl = new URL('/health', withTrailingSlash(baseUrl));
  const startedAt = Date.now();
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    const body = await response.json().catch(() => ({})) as {
      ready?: boolean;
      ok?: boolean;
      pid?: number;
      uptimeSeconds?: number;
      lastError?: string | null;
    };
    const ready = response.ok && Boolean(body.ready ?? body.ok);
    return {
      url: healthUrl.toString(),
      ready,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      pid: body.pid ?? null,
      uptimeSeconds: body.uptimeSeconds ?? null,
      error: ready ? null : body.lastError ?? `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      url: healthUrl.toString(),
      ready: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      pid: null,
      uptimeSeconds: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getQwenModelServiceBaseUrl(serviceId: QwenModelServiceId): string {
  return serviceId === 'qwen-vlm'
    ? GLOBAL_CONFIG.MODEL_SERVICES.QWEN_VLM_BASE_URL
    : GLOBAL_CONFIG.MODEL_SERVICES.QWEN_ROUTER_BASE_URL;
}

function getFfmpegStatus(): DashboardServiceItem {
  return {
    id: 'ffmpeg',
    name: 'FFmpeg',
    status: 'unknown',
    controllable: false,
    controlReason: 'FFmpeg is launched on demand by camera, audio, and media tasks.',
    pid: null,
    resources: { cpuPercent: null, memoryMb: null, uptimeSeconds: null },
    interfaces: [{
      label: 'Binary',
      url: GLOBAL_CONFIG.FFMPEG.BIN,
      status: 'unknown',
      statusCode: null,
      latencyMs: null,
      error: 'Binary availability is validated when media streams start.',
    }],
    logsAvailable: false,
    actions: [],
    lastError: null,
  };
}

async function collectDashboardMetrics(): Promise<DashboardMetrics> {
  const [currentLoad, cpu, graphics, mem, osInfo, processes, macMemory, macProcesses] = await Promise.all([
    safeSi(() => si.currentLoad()),
    safeSi(() => si.cpu()),
    safeSi(() => si.graphics()),
    safeSi(() => si.mem()),
    safeSi(() => si.osInfo()),
    safeSi(() => si.processes()),
    collectMacMemory(),
    collectMacProcesses(),
  ]);
  return {
    currentLoad,
    cpu,
    graphics,
    mem,
    osInfo,
    processes,
    macMemory,
    macProcesses,
    time: si.time(),
  };
}

async function safeSi<T>(reader: () => Promise<T>): Promise<T | null> {
  try {
    return await reader();
  } catch (error) {
    appendLog('main', 'warn', `systeminformation read failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function getYtDlpDashboardStatus(): Promise<DashboardServiceItem> {
  const status = await getYtDlpStatus();
  return {
    id: 'yt-dlp',
    name: 'yt-dlp',
    status: status.installed ? 'running' : 'stopped',
    controllable: false,
    controlReason: 'yt-dlp is a command-line dependency, not a daemon.',
    pid: null,
    resources: { cpuPercent: null, memoryMb: null, uptimeSeconds: null },
    interfaces: [{
      label: 'Binary',
      url: status.bin,
      status: status.installed ? 'ok' : 'failed',
      statusCode: null,
      latencyMs: null,
      error: status.error,
    }],
    logsAvailable: false,
    actions: [],
    lastError: status.error,
  };
}

async function startManagedCosyVoice(): Promise<void> {
  const health = await checkCosyVoiceService();
  if (health.ok) {
    await postCosyVoiceStart().catch(() => undefined);
    appendLog('cosyvoice', 'info', `CosyVoice already online at ${health.url}.`);
    cosyVoiceLastError = null;
    return;
  }
  if (cosyVoiceStarting) {
    appendLog('cosyvoice', 'info', 'CosyVoice start requested while already starting/running.');
    return;
  }

  cosyVoiceStarting = true;
  cosyVoiceLastError = null;
  const startedAt = Date.now();
  appendLog('cosyvoice', 'info', `Starting CosyVoice at ${GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL}`);
  try {
    await runPythonServiceManager(['start', 'cosyvoice']);
    await postCosyVoiceStart();
    await waitForCosyVoiceReady();
    cosyVoiceStarting = false;
    cosyVoiceLastError = null;
    appendLog('cosyvoice', 'info', `CosyVoice service is ready in ${Date.now() - startedAt}ms.`);
  } catch (error) {
    cosyVoiceStarting = false;
    cosyVoiceLastError = error instanceof Error ? error.message : 'CosyVoice startup failed.';
    appendLog('cosyvoice', 'error', `${cosyVoiceLastError} (${Date.now() - startedAt}ms)`);
    throw error;
  }
}

async function stopManagedCosyVoice(): Promise<void> {
  appendLog('cosyvoice', 'info', 'Stopping dashboard-managed CosyVoice process...');
  await fetch(new URL('/stop', withTrailingSlash(GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL)), {
    method: 'POST',
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
  await runPythonServiceManager(['stop', 'cosyvoice']);
  cosyVoiceStarting = false;
}

async function waitForCosyVoiceReady(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const health = await checkCosyVoiceService();
    if (health.ok) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  throw new Error('CosyVoice Service startup timeout (60s)');
}

async function postCosyVoiceStart(): Promise<void> {
  const response = await fetch(new URL('/start', withTrailingSlash(GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL)), {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`CosyVoice start failed status=${response.status}${detail ? ` detail=${detail.slice(0, 300)}` : ''}`);
  }
}

async function runPythonServiceManager(args: string[]): Promise<void> {
  const { stdout, stderr } = await execFileAsync(`${GLOBAL_CONFIG.VOICE.PYTHON_SERVICES_SCRIPT_ROOT}/bin/manage`, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHON_SERVICES_ROOT: GLOBAL_CONFIG.VOICE.PYTHON_SERVICES_ROOT,
      PYTHON_SERVICES_DEVICE: GLOBAL_CONFIG.VOICE.PYTHON_SERVICES_DEVICE,
      FUNASR_PORT: String(GLOBAL_CONFIG.VOICE.FUNASR_PORT),
      COSYVOICE_PORT: String(GLOBAL_CONFIG.VOICE.COSYVOICE_PORT),
      MDX_PORT: String(GLOBAL_CONFIG.VOICE.MDX_PORT),
      QWEN_VLM_PORT: String(GLOBAL_CONFIG.VOICE.QWEN_VLM_PORT),
      QWEN_ROUTER_PORT: String(GLOBAL_CONFIG.VOICE.QWEN_ROUTER_PORT),
      VOICE_SEPARATION_MODEL_DIR: GLOBAL_CONFIG.VOICE.SEPARATION_MODEL_DIR,
      VOICE_SEPARATION_MODEL: GLOBAL_CONFIG.VOICE.SEPARATION_MODEL,
      VOICE_SEPARATION_DEVICE: GLOBAL_CONFIG.VOICE.SEPARATION_DEVICE,
      VOICE_SEPARATION_ONNX_PROVIDERS: GLOBAL_CONFIG.VOICE.SEPARATION_ONNX_PROVIDERS,
      COSYVOICE_MODEL_DIR: GLOBAL_CONFIG.VOICE.COSYVOICE_MODEL_DIR,
      QWEN_VLM_MODEL_DIR: GLOBAL_CONFIG.MODEL_SERVICES.QWEN_VLM_MODEL_DIR,
      QWEN_ROUTER_FAST_MODEL_DIR: GLOBAL_CONFIG.MODEL_SERVICES.QWEN_ROUTER_FAST_MODEL_DIR,
      QWEN_ROUTER_REPAIR_MODEL_DIR: GLOBAL_CONFIG.MODEL_SERVICES.QWEN_ROUTER_REPAIR_MODEL_DIR,
      QWEN_VLM_MODEL_ID: GLOBAL_CONFIG.MODEL_SERVICES.QWEN_VLM_MODEL_ID,
      QWEN_ROUTER_FAST_MODEL_ID: GLOBAL_CONFIG.MODEL_SERVICES.QWEN_ROUTER_FAST_MODEL_ID,
      QWEN_ROUTER_REPAIR_MODEL_ID: GLOBAL_CONFIG.MODEL_SERVICES.QWEN_ROUTER_REPAIR_MODEL_ID,
      QWEN_ROUTER_REPAIR_WAIT_MS: String(GLOBAL_CONFIG.MODEL_SERVICES.ROUTER_REPAIR_WAIT_MS),
      QWEN_MODEL_SERVICE_TIMEOUT_MS: String(GLOBAL_CONFIG.MODEL_SERVICES.REQUEST_TIMEOUT_MS),
      QWEN_MODEL_WARMUP_ON_START: GLOBAL_CONFIG.MODEL_SERVICES.WARMUP_ON_START ? '1' : '0',
    },
    timeout: 90_000,
  });
  const output = `${stdout}${stderr}`.trim();
  if (output) appendLog(SERVICE_IDS.has(args[1] ?? '') ? args[1]! : 'main', 'info', output);
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function buildRecommendations(services: DashboardServiceItem[]): DashboardStatus['recommendations'] {
  const assistantRuntime = services.find(service => service.id === 'assistant-runtime');
  const assistantRuntimeStopped = assistantRuntime?.status === 'stopped';
  const recommendations: DashboardStatus['recommendations'] = [{
    level: 'info',
    title: 'GPU metrics unavailable',
    detail: 'The dashboard does not collect GPU metrics without an external exporter.',
  }];
  if (assistantRuntimeStopped) {
    recommendations.push({
      level: 'info',
      title: 'Assistant runtime is offline',
      detail: 'Use the sidebar control or dashboard card to start camera, microphone, ASR, and model services.',
      serviceId: 'assistant-runtime',
    });
  }
  for (const service of services) {
    if (assistantRuntimeStopped && ['monitor', 'realtime-socket', 'webrtc', 'funasr', 'cosyvoice', 'voice-separation', 'qwen-vlm', 'qwen-router'].includes(service.id)) {
      continue;
    }
    if (service.status === 'error' || service.status === 'degraded') {
      recommendations.push({
        level: 'critical',
        title: `${service.name} needs attention`,
        detail: service.lastError ?? 'Service reported an unhealthy state.',
        serviceId: service.id,
      });
    } else if (service.id === 'cosyvoice' && service.status === 'stopped') {
      recommendations.push({
        level: 'warning',
        title: 'CosyVoice is offline',
        detail: service.controllable ? 'Start it from the dashboard before using CosyVoice TTS.' : service.controlReason ?? 'Install CosyVoice before starting it.',
        serviceId: service.id,
      });
    } else if (service.id === 'funasr' && service.status === 'stopped') {
      recommendations.push({
        level: 'info',
        title: 'FunASR is idle',
        detail: 'It will start on demand, or you can prewarm it from the dashboard.',
        serviceId: service.id,
      });
    }
  }
  return recommendations;
}

function getAssistantRuntimeSnapshot(): AssistantRuntimeStatus {
  return getAssistantRuntimeServiceIfInitialized()?.getStatus() ?? STOPPED_ASSISTANT_RUNTIME;
}

function getRuntimeOwnedService(runtime: AssistantRuntimeStatus, id: AssistantRuntimeServiceState['id']): AssistantRuntimeServiceState {
  return runtime.services.find(service => service.id === id) ?? { id, status: 'stopped', message: null };
}

function getRuntimeTask(runtime: AssistantRuntimeStatus, id: AssistantRuntimeTask['id']): AssistantRuntimeTask | null {
  return runtime.tasks.find(task => task.id === id) ?? null;
}

function aggregateProductStatus(
  runtime: AssistantRuntimeStatus,
  taskStatuses: Array<AssistantRuntimeTask['status'] | undefined>,
  serviceStatuses: DashboardServiceStatus[],
): DashboardServiceStatus {
  if (runtime.status === 'stopped') return 'stopped';
  if (runtime.status === 'error') return 'error';
  if (taskStatuses.includes('failed') || serviceStatuses.includes('error')) return 'error';
  if (runtime.status === 'degraded' || serviceStatuses.includes('degraded')) return 'degraded';
  if (taskStatuses.includes('running') || serviceStatuses.includes('starting') || runtime.status === 'starting') return 'starting';
  if (taskStatuses.includes('stopping') || serviceStatuses.includes('stopping') || runtime.status === 'stopping') return 'stopping';
  if (taskStatuses.includes('ready') || serviceStatuses.includes('running')) return 'running';
  return 'stopped';
}

function toDashboardStatus(status: AssistantRuntimeServiceState['status']): DashboardServiceStatus {
  return status;
}

function appendLog(serviceId: string, level: DashboardLogEntry['level'], message: string): void {
  const normalized = message.trim();
  if (!normalized) return;
  const logs = dashboardLogs.get(serviceId) ?? [];
  logs.push({ ts: Date.now(), level, message: normalized });
  if (logs.length > 500) {
    logs.splice(0, logs.length - 500);
  }
  dashboardLogs.set(serviceId, logs);
}

function findProcessByPid(metrics: DashboardMetrics, pid: number | null | undefined): Systeminformation.ProcessesProcessData | null {
  if (!pid) return null;
  return metrics.processes?.list.find(item => item.pid === pid) ?? null;
}

function findProcessByName(metrics: DashboardMetrics, name: string): Systeminformation.ProcessesProcessData | null {
  const normalized = name.toLowerCase();
  return metrics.processes?.list.find(item => item.name.toLowerCase().includes(normalized)) ?? null;
}

function findProcessByCommand(metrics: DashboardMetrics, needle: string): Systeminformation.ProcessesProcessData | null {
  return metrics.processes?.list.find(item => `${item.command} ${item.params}`.includes(needle)) ?? null;
}

function getProcessSnapshot(metrics: DashboardMetrics, pid: number | null | undefined): MacProcessSnapshot {
  const empty = { pid: pid ?? 0, cpuPercent: null, memoryMb: null, uptimeSeconds: null };
  if (!pid) return empty;
  const macProcess = metrics.macProcesses.get(pid);
  if (macProcess) return macProcess;
  const processInfo = findProcessByPid(metrics, pid);
  return {
    pid,
    cpuPercent: formatProcessCpu(processInfo?.cpu),
    memoryMb: processInfo ? bytesToMb(processInfo.memRss * 1024) : null,
    uptimeSeconds: null,
  };
}

function formatProcessCpu(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? round(value, 1) : null;
}

async function collectMacMemory(): Promise<MacMemorySnapshot | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const [{ stdout: vmStatOutput }, mem] = await Promise.all([
      execFileAsync('vm_stat'),
      safeSi(() => si.mem()),
    ]);
    const pageSizeMatch = vmStatOutput.match(/page size of (\d+) bytes/i);
    const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
    const pages = parseVmStatPages(vmStatOutput);
    const totalMb = bytesToMb(mem?.total ?? 0);
    if (totalMb <= 0) return null;

    const appBytes = (pages['Anonymous pages'] ?? 0) * pageSize;
    const wiredBytes = (pages['Pages wired down'] ?? 0) * pageSize;
    const compressedBytes = (pages['Pages occupied by compressor'] ?? 0) * pageSize;
    const usedMb = Math.min(totalMb, bytesToMb(appBytes + wiredBytes + compressedBytes));
    return {
      totalMb,
      usedMb,
      freeMb: Math.max(0, round(totalMb - usedMb, 1)),
    };
  } catch (error) {
    appendLog('main', 'warn', `macOS memory read failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function collectMacProcesses(): Promise<Map<number, MacProcessSnapshot>> {
  if (process.platform !== 'darwin') return new Map();
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,%cpu=,rss=,etime=']);
    return parsePsProcessSnapshots(stdout);
  } catch (error) {
    appendLog('main', 'warn', `macOS process read failed: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
}

function parseVmStatPages(output: string): Record<string, number> {
  const pages: Record<string, number> = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^"?([^":]+)"?:\s+(\d+)\./);
    if (match) {
      const label = match[1];
      const count = match[2];
      if (label && count) {
        pages[label.trim()] = Number(count);
      }
    }
  }
  return pages;
}

function parsePsProcessSnapshots(output: string): Map<number, MacProcessSnapshot> {
  const snapshots = new Map<number, MacProcessSnapshot>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pidValue, cpuValue, rssValue, elapsedValue] = match;
    if (!pidValue || !cpuValue || !rssValue || !elapsedValue) continue;
    const pid = Number(pidValue);
    snapshots.set(pid, {
      pid,
      cpuPercent: round(Number(cpuValue), 1),
      memoryMb: bytesToMb(Number(rssValue) * 1024),
      uptimeSeconds: parsePsElapsed(elapsedValue),
    });
  }
  return snapshots;
}

function parsePsElapsed(value: string): number | null {
  const dayParts = value.trim().split('-');
  const timePart = dayParts.at(-1);
  if (!timePart) return null;
  const parts = timePart.split(':').map(part => Number(part));
  if (parts.some(part => !Number.isFinite(part))) return null;
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  if (!Number.isFinite(days)) return null;
  const [hours, minutes, seconds] = parts.length === 3
    ? parts
    : [0, parts[0], parts[1]];
  if (hours === undefined || minutes === undefined || seconds === undefined) return null;
  return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
}

function mergeLogs(first: DashboardLogEntry[], second: DashboardLogEntry[], limit: number): DashboardLogEntry[] {
  return [...first, ...second]
    .sort((a, b) => a.ts - b.ts)
    .slice(-normalizeLimit(limit));
}

function assertKnownService(serviceId: string): void {
  if (!SERVICE_IDS.has(serviceId)) {
    throw new Error(`Unknown dashboard service: ${serviceId}`);
  }
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 200, 500));
}

function bytesToMb(value: number): number {
  return round(value / 1024 / 1024, 1);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
