import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { loadavg } from 'os';
import { resolve } from 'path';
import { promisify } from 'util';
import si, { type Systeminformation } from 'systeminformation';
import { GLOBAL_CONFIG } from '@/global_config';
import { funasrService } from '@/server/services/FunASRService';
import { checkCosyVoiceService, getYtDlpStatus } from '@/server/services/CosyVoiceMaterialService';
import { getCosyVoicePaths, isCosyVoiceInstalled } from '@/server/scripts/cosyvoice_common';

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

const SERVICE_IDS = new Set(['main', 'realtime-socket', 'webrtc', 'monitor', 'funasr', 'cosyvoice', 'ffmpeg', 'yt-dlp']);
const dashboardLogs = new Map<string, DashboardLogEntry[]>();
const execFileAsync = promisify(execFile);
let cosyVoiceProcess: ChildProcess | null = null;
let cosyVoiceStartedAt = 0;
let cosyVoiceStarting = false;
let cosyVoiceLastError: string | null = null;

export async function getDashboardStatus(): Promise<DashboardStatus> {
  const metrics = await collectDashboardMetrics();
  const [cosyVoice, ytDlp] = await Promise.all([
    getCosyVoiceDashboardStatus(metrics),
    getYtDlpDashboardStatus(),
  ]);
  const funasr = getFunAsrDashboardStatus(metrics);
  const services = [
    getMainServiceStatus(metrics),
    getRealtimeSocketStatus(metrics),
    getWebRtcStatus(metrics),
    getMonitorStatus(metrics),
    funasr,
    cosyVoice,
    getFfmpegStatus(),
    ytDlp,
  ];

  return {
    system: getSystemStatus(metrics),
    services,
    recommendations: buildRecommendations(services),
  };
}

export async function startDashboardService(serviceId: string): Promise<DashboardServiceItem> {
  assertKnownService(serviceId);
  if (serviceId === 'funasr') {
    appendLog('funasr', 'info', 'Start requested from dashboard');
    await funasrService.start();
    return getFunAsrDashboardStatus(await collectDashboardMetrics());
  }
  if (serviceId === 'cosyvoice') {
    await startManagedCosyVoice();
    return getCosyVoiceDashboardStatus(await collectDashboardMetrics());
  }
  throw new Error(`Service ${serviceId} is read-only from dashboard.`);
}

export async function stopDashboardService(serviceId: string): Promise<DashboardServiceItem> {
  assertKnownService(serviceId);
  if (serviceId === 'funasr') {
    appendLog('funasr', 'info', 'Stop requested from dashboard');
    funasrService.stop();
    return getFunAsrDashboardStatus(await collectDashboardMetrics());
  }
  if (serviceId === 'cosyvoice') {
    await stopManagedCosyVoice();
    return getCosyVoiceDashboardStatus(await collectDashboardMetrics());
  }
  throw new Error(`Service ${serviceId} is read-only from dashboard.`);
}

export function getDashboardServiceLogs(serviceId: string, limit = 200): DashboardLogEntry[] {
  assertKnownService(serviceId);
  if (serviceId === 'funasr') {
    return mergeLogs(funasrService.getLogs(limit), dashboardLogs.get('funasr') ?? [], limit);
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

function getRealtimeSocketStatus(metrics: DashboardMetrics): DashboardServiceItem {
  const processInfo = getProcessSnapshot(metrics, process.pid);
  return {
    id: 'realtime-socket',
    name: 'Realtime Socket',
    status: 'running',
    controllable: false,
    controlReason: 'Realtime socket is owned by the monitor/main server lifecycle.',
    pid: process.pid,
    resources: {
      cpuPercent: processInfo.cpuPercent,
      memoryMb: processInfo.memoryMb,
      uptimeSeconds: processInfo.uptimeSeconds ?? Math.floor(process.uptime()),
    },
    interfaces: [{
      label: 'WebSocket',
      url: `ws://localhost:${GLOBAL_CONFIG.SERVER.SOCKET_PORT}/ws/realtime`,
      status: 'unknown',
      statusCode: null,
      latencyMs: null,
      error: 'WebSocket upgrade is not probed by dashboard polling.',
    }],
    logsAvailable: false,
    actions: [],
    lastError: null,
  };
}

function getWebRtcStatus(metrics: DashboardMetrics): DashboardServiceItem {
  const enabled = GLOBAL_CONFIG.SERVER.DEMO_MODE !== 'audio';
  const ffmpeg = findProcessByName(metrics, 'ffmpeg');
  const processInfo = getProcessSnapshot(metrics, ffmpeg?.pid);
  return {
    id: 'webrtc',
    name: 'WebRTC Stream',
    status: enabled ? 'unknown' : 'stopped',
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
      status: enabled ? 'unknown' : 'failed',
      statusCode: null,
      latencyMs: null,
      error: enabled ? 'Waiting for a browser WebRTC session.' : 'Disabled in audio demo mode.',
    }],
    logsAvailable: false,
    actions: [],
    lastError: null,
  };
}

function getMonitorStatus(metrics: DashboardMetrics): DashboardServiceItem {
  const processInfo = getProcessSnapshot(metrics, process.pid);
  return {
    id: 'monitor',
    name: 'Sentinel Monitor',
    status: 'running',
    controllable: false,
    controlReason: 'Camera and microphone loops are coupled to the assistant runtime.',
    pid: process.pid,
    resources: {
      cpuPercent: processInfo.cpuPercent,
      memoryMb: processInfo.memoryMb,
      uptimeSeconds: processInfo.uptimeSeconds ?? Math.floor(process.uptime()),
    },
    interfaces: [
      { label: 'Camera', url: `avfoundation:${GLOBAL_CONFIG.VIDEO.DEVICE}`, status: 'unknown', statusCode: null, latencyMs: null, error: 'Hardware stream health is reported in live monitor.' },
      { label: 'Microphone', url: `avfoundation:${GLOBAL_CONFIG.VOICE.DEVICE}`, status: 'unknown', statusCode: null, latencyMs: null, error: 'Hardware stream health is reported in live monitor.' },
    ],
    logsAvailable: false,
    actions: [],
    lastError: null,
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
      label: 'stdin worker',
      url: GLOBAL_CONFIG.VOICE.FUNASR_CMD,
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
  const paths = getCosyVoicePaths();
  const installed = isCosyVoiceInstalled(paths.installDir);
  const service = await checkCosyVoiceService();
  const isManaged = cosyVoiceProcess !== null;
  const systemProcessInfo = findProcessByPid(metrics, cosyVoiceProcess?.pid ?? null)
    ?? findProcessByCommand(metrics, 'cosyvoice_mlx_fastapi_server.py');
  const processInfo = getProcessSnapshot(metrics, cosyVoiceProcess?.pid ?? systemProcessInfo?.pid);
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
    controllable: installed,
    controlReason: installed ? null : `CosyVoice is not installed at ${paths.installDir}.`,
    pid: cosyVoiceProcess?.pid ?? systemProcessInfo?.pid ?? null,
    resources: {
      cpuPercent: processInfo.cpuPercent,
      memoryMb: processInfo.memoryMb,
      uptimeSeconds: cosyVoiceStartedAt ? Math.floor((Date.now() - cosyVoiceStartedAt) / 1000) : processInfo.uptimeSeconds,
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
    actions: service.ok
      ? (isManaged ? ['stop'] : [])
      : (installed && !cosyVoiceStarting ? ['start'] : []),
    lastError: cosyVoiceLastError ?? service.error,
  };
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
  const paths = getCosyVoicePaths();
  if (!isCosyVoiceInstalled(paths.installDir)) {
    throw new Error(`CosyVoice is not installed at ${paths.installDir}.`);
  }
  const health = await checkCosyVoiceService();
  if (health.ok) {
    appendLog('cosyvoice', 'info', `CosyVoice already online at ${health.url}; treating as external service.`);
    cosyVoiceLastError = null;
    return;
  }
  if (cosyVoiceProcess || cosyVoiceStarting) {
    appendLog('cosyvoice', 'info', 'CosyVoice start requested while already starting/running.');
    return;
  }

  const envPrefix = resolve(paths.installDir, '.conda');
  const serverPath = resolve('src/server/scripts/cosyvoice_mlx_fastapi_server.py');
  if (!existsSync(envPrefix) || !existsSync(serverPath)) {
    throw new Error('CosyVoice runtime files are missing. Run bun run cosyvoice:install first.');
  }

  cosyVoiceStarting = true;
  cosyVoiceLastError = null;
  appendLog('cosyvoice', 'info', `Starting CosyVoice at http://${paths.host}:${paths.port}`);
  cosyVoiceProcess = spawn(resolve(envPrefix, 'bin/python'), [
    serverPath,
    '--port', paths.port,
    '--model_dir', paths.modelDir,
    '--cache_dir', resolve('data/cosyvoice/mlx-speaker-cache'),
  ], {
    cwd: paths.installDir,
    env: process.env,
  });

  cosyVoiceProcess.stdout?.on('data', chunk => appendLog('cosyvoice', 'info', chunk.toString().trim()));
  cosyVoiceProcess.stderr?.on('data', chunk => appendLog('cosyvoice', 'warn', chunk.toString().trim()));
  cosyVoiceProcess.once('spawn', () => {
    cosyVoiceStartedAt = Date.now();
    appendLog('cosyvoice', 'info', `Spawned CosyVoice process pid=${cosyVoiceProcess?.pid ?? 'unknown'}`);
  });
  cosyVoiceProcess.once('error', (error) => {
    cosyVoiceLastError = error.message;
    cosyVoiceStarting = false;
    appendLog('cosyvoice', 'error', `Process error: ${error.message}`);
  });
  cosyVoiceProcess.once('exit', (code, signal) => {
    const message = `CosyVoice process exited code=${code}, signal=${signal}`;
    if (code === 0 || code === null) {
      appendLog('cosyvoice', 'info', message);
    } else {
      cosyVoiceLastError = message;
      appendLog('cosyvoice', 'error', message);
    }
    cosyVoiceProcess = null;
    cosyVoiceStartedAt = 0;
    cosyVoiceStarting = false;
  });

  try {
    await waitForCosyVoiceReady();
    cosyVoiceStarting = false;
    cosyVoiceLastError = null;
    appendLog('cosyvoice', 'info', 'CosyVoice service is ready.');
  } catch (error) {
    cosyVoiceStarting = false;
    cosyVoiceLastError = error instanceof Error ? error.message : 'CosyVoice startup failed.';
    appendLog('cosyvoice', 'error', cosyVoiceLastError);
    throw error;
  }
}

async function stopManagedCosyVoice(): Promise<void> {
  if (!cosyVoiceProcess) {
    appendLog('cosyvoice', 'warn', 'Stop requested, but CosyVoice was not started by dashboard.');
    return;
  }
  appendLog('cosyvoice', 'info', 'Stopping dashboard-managed CosyVoice process...');
  await new Promise<void>((resolveStop) => {
    const child = cosyVoiceProcess;
    if (!child) {
      resolveStop();
      return;
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
  cosyVoiceProcess = null;
  cosyVoiceStartedAt = 0;
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

function buildRecommendations(services: DashboardServiceItem[]): DashboardStatus['recommendations'] {
  const recommendations: DashboardStatus['recommendations'] = [{
    level: 'info',
    title: 'GPU metrics unavailable',
    detail: 'The dashboard does not collect GPU metrics without an external exporter.',
  }];
  for (const service of services) {
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
