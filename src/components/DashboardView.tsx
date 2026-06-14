import { type FC, useEffect, useMemo, useState } from 'react';
import { IconActivity } from './Icons';
import { useI18n } from '../i18n';

type ServiceStatus = 'running' | 'starting' | 'stopping' | 'stopped' | 'degraded' | 'error' | 'unknown';
type InterfaceStatus = 'ok' | 'failed' | 'unknown';

type DashboardLogEntry = {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
};

type DashboardService = {
  id: string;
  name: string;
  status: ServiceStatus;
  controllable: boolean;
  controlReason: string | null;
  pid: number | null;
  resources: {
    cpuPercent: number | null;
    memoryMb: number | null;
    uptimeSeconds: number | null;
  };
  interfaces: Array<{
    label: string;
    url: string;
    status: InterfaceStatus;
    statusCode: number | null;
    latencyMs: number | null;
    error: string | null;
  }>;
  logsAvailable: boolean;
  actions: Array<'start' | 'stop'>;
  lastError: string | null;
};

type DashboardServiceGroup = {
  id: 'primary' | 'advanced';
  title: string;
  collapsed: boolean;
  services: DashboardService[];
};

type DashboardStatus = {
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
  services: DashboardService[];
  serviceGroups?: DashboardServiceGroup[];
  recommendations: Array<{
    level: 'info' | 'warning' | 'critical';
    title: string;
    detail: string;
    serviceId?: string;
  }>;
};

const STATUS_STYLES: Record<ServiceStatus, string> = {
  running: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  starting: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  stopping: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  stopped: 'border-slate-700 bg-slate-800/60 text-slate-300',
  degraded: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  error: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  unknown: 'border-slate-700 bg-slate-800/60 text-slate-400',
};

const INTERFACE_STYLES: Record<InterfaceStatus, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-rose-500/15 text-rose-300',
  unknown: 'bg-slate-800 text-slate-400',
};

export const DashboardView: FC = () => {
  const { t } = useI18n();
  const [dashboard, setDashboard] = useState<DashboardStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyServiceId, setBusyServiceId] = useState('');
  const [expandedServiceIds, setExpandedServiceIds] = useState<Set<string>>(new Set());
  const [logServiceIds, setLogServiceIds] = useState<Set<string>>(new Set());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [logsByService, setLogsByService] = useState<Record<string, DashboardLogEntry[]>>({});

  useEffect(() => {
    const controller = new AbortController();
    void loadDashboard(controller.signal);
    const timer = window.setInterval(() => {
      void loadDashboard(controller.signal);
    }, 2000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    for (const serviceId of logServiceIds) {
      void loadLogs(serviceId);
    }
  }, [logServiceIds, dashboard]);

  const serviceSummary = useMemo(() => {
    const services = dashboard?.serviceGroups?.find(group => group.id === 'primary')?.services ?? dashboard?.services ?? [];
    const running = services.filter(service => service.status === 'running').length;
    const attention = services.filter(service => service.status === 'error' || service.status === 'degraded').length;
    return { total: services.length, running, attention };
  }, [dashboard]);
  const primaryServices = dashboard?.serviceGroups?.find(group => group.id === 'primary')?.services ?? dashboard?.services ?? [];
  const advancedServices = dashboard?.serviceGroups?.find(group => group.id === 'advanced')?.services ?? [];

  async function loadDashboard(signal?: AbortSignal) {
    try {
      const response = await fetch('/api/dashboard/status', { signal });
      const data = await response.json().catch(() => null) as unknown;
      const errorMessage = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : null;
      if (!response.ok) throw new Error(errorMessage ?? `HTTP ${response.status}`);
      if (!data || typeof data !== 'object' || errorMessage) throw new Error(errorMessage ?? 'Dashboard status unavailable');
      setDashboard(data as DashboardStatus);
      setError('');
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === 'AbortError') return;
      setError(nextError instanceof Error ? nextError.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }

  async function runAction(serviceId: string, action: 'start' | 'stop') {
    setBusyServiceId(serviceId);
    try {
      const response = await fetch(`/api/dashboard/services/${encodeURIComponent(serviceId)}/${action}`, {
        method: 'POST',
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await loadDashboard();
      if (logServiceIds.has(serviceId)) {
        await loadLogs(serviceId);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Action failed');
    } finally {
      setBusyServiceId('');
    }
  }

  async function loadLogs(serviceId: string) {
    try {
      const response = await fetch(`/api/dashboard/services/${encodeURIComponent(serviceId)}/logs?limit=200`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { logs?: DashboardLogEntry[] };
      setLogsByService(value => ({ ...value, [serviceId]: data.logs ?? [] }));
    } catch {
      setLogsByService(value => ({ ...value, [serviceId]: [] }));
    }
  }

  function toggleSet(setter: (value: Set<string>) => void, current: Set<string>, serviceId: string) {
    const next = new Set(current);
    if (next.has(serviceId)) next.delete(serviceId);
    else next.add(serviceId);
    setter(next);
  }

  function renderServiceCard(service: DashboardService) {
    const expanded = expandedServiceIds.has(service.id);
    const logsOpen = logServiceIds.has(service.id);
    const busy = busyServiceId === service.id;
    return (
      <article key={service.id} className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold text-white">{service.name}</h4>
              <StatusPill status={service.status} />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-500 md:grid-cols-4">
              <span>PID {service.pid ?? '-'}</span>
              <span>CPU {formatPercent(service.resources.cpuPercent)}</span>
              <span>MEM {service.resources.memoryMb === null ? '-' : `${service.resources.memoryMb} MB`}</span>
              <span>{formatDuration(service.resources.uptimeSeconds)}</span>
            </div>
            {service.lastError ? <div className="mt-3 text-xs text-rose-300">{service.lastError}</div> : null}
            {!service.controllable && service.controlReason ? (
              <div className="mt-3 text-xs text-slate-500">{service.controlReason}</div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            {service.actions.includes('start') ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction(service.id, 'start')}
                className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? t('dashboard.working') : t('dashboard.start')}
              </button>
            ) : null}
            {service.actions.includes('stop') ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction(service.id, 'stop')}
                className="rounded-md bg-rose-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? t('dashboard.working') : t('dashboard.stop')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => toggleSet(setExpandedServiceIds, expandedServiceIds, service.id)}
              className="rounded-md border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              {expanded ? t('dashboard.hideInterfaces') : t('dashboard.showInterfaces')}
            </button>
            {service.logsAvailable ? (
              <button
                type="button"
                onClick={() => toggleSet(setLogServiceIds, logServiceIds, service.id)}
                className="rounded-md border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                {logsOpen ? t('dashboard.hideLogs') : t('dashboard.showLogs')}
              </button>
            ) : null}
          </div>
        </div>

        {expanded ? (
          <div className="mt-5 space-y-2">
            {service.interfaces.map((item, index) => (
              <div key={`${service.id}-${item.label}-${index}`} className="rounded-md border border-slate-800 bg-slate-950/70 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-200">{item.label}</div>
                    <div className="mt-1 truncate font-mono text-xs text-slate-500">{item.url}</div>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${INTERFACE_STYLES[item.status]}`}>
                    {item.status}
                  </span>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  HTTP {item.statusCode ?? '-'} · {item.latencyMs === null ? '-' : `${item.latencyMs}ms`}
                </div>
                {item.error ? <div className="mt-2 text-xs text-amber-300">{item.error}</div> : null}
              </div>
            ))}
          </div>
        ) : null}

        {logsOpen ? (
          <div className="mt-5 rounded-md border border-slate-800 bg-slate-950 p-3">
            <div className="mb-2 text-xs font-bold uppercase tracking-widest text-slate-500">{t('dashboard.logs')}</div>
            <div className="max-h-56 space-y-1 overflow-auto font-mono text-[11px] leading-5">
              {(logsByService[service.id] ?? []).map((entry, index) => (
                <div key={`${entry.ts}-${index}`} className={entry.level === 'error' ? 'text-rose-300' : entry.level === 'warn' ? 'text-amber-300' : 'text-slate-400'}>
                  {new Date(entry.ts).toLocaleTimeString()} [{entry.level}] {entry.message}
                </div>
              ))}
              {(logsByService[service.id] ?? []).length === 0 ? (
                <div className="text-slate-600">{t('dashboard.noLogs')}</div>
              ) : null}
            </div>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-slate-500">{t('dashboard.overview')}</div>
          <h3 className="mt-1 text-2xl font-bold text-white">{t('dashboard.commandCenter')}</h3>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-slate-400">
          <span className="rounded-full border border-slate-800 bg-slate-900 px-3 py-1.5">{t('dashboard.autoRefresh')}</span>
          <span className="rounded-full border border-slate-800 bg-slate-900 px-3 py-1.5">
            {serviceSummary.running}/{serviceSummary.total} {t('dashboard.servicesRunning')}
          </span>
          {serviceSummary.attention > 0 ? (
            <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-rose-300">
              {serviceSummary.attention} {t('dashboard.needAttention')}
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>
      ) : null}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={t('dashboard.cpuLoad')} value={formatPercent(dashboard?.system.cpuPercent)} detail={t('dashboard.systemWide')} />
        <MetricCard label={t('dashboard.memory')} value={formatPercent(dashboard?.system.memory.usedPercent)} detail={dashboard ? `${dashboard.system.memory.usedMb} / ${dashboard.system.memory.totalMb} MB` : '-'} />
        <MetricCard label={t('dashboard.processMemory')} value={dashboard ? `${dashboard.system.process.memoryMb} MB` : '-'} detail={`PID ${dashboard?.system.process.pid ?? '-'}`} />
        <MetricCard label={t('dashboard.uptime')} value={formatDuration(dashboard?.system.uptimeSeconds)} detail={dashboard ? `${dashboard.system.platform.name} ${dashboard.system.platform.arch}` : '-'} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-5 lg:col-span-2">
          <div className="mb-5 flex items-center gap-2">
            <IconActivity />
            <h3 className="font-bold text-white">{t('dashboard.systemSignals')}</h3>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <SignalTile label={t('dashboard.loadAverage')} value={dashboard?.system.loadAverage.join(' / ') || '-'} />
            <SignalTile label={t('dashboard.cpu')} value={dashboard?.system.cpu.brand ?? '-'} detail={dashboard ? `${dashboard.system.cpu.cores} cores · ${dashboard.system.cpu.physicalCores} physical` : undefined} />
            <SignalTile label={t('dashboard.gpu')} value={dashboard?.system.gpu.available ? t('dashboard.available') : t('dashboard.unavailable')} detail={formatGpuDetail(dashboard?.system.gpu)} />
          </div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
          <h3 className="font-bold text-white">{t('dashboard.recommendations')}</h3>
          <div className="mt-4 space-y-3">
            {(dashboard?.recommendations ?? []).map((item, index) => (
              <div key={`${item.title}-${index}`} className={`rounded-md border p-3 ${recommendationClassName(item.level)}`}>
                <div className="text-sm font-semibold">{item.title}</div>
                <div className="mt-1 text-xs leading-5 opacity-80">{item.detail}</div>
              </div>
            ))}
            {!loading && (dashboard?.recommendations.length ?? 0) === 0 ? (
              <div className="text-sm text-slate-500">{t('dashboard.noRecommendations')}</div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-white">{t('dashboard.services')}</h3>
          <button
            type="button"
            onClick={() => loadDashboard()}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            {t('dashboard.refresh')}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {primaryServices.map(renderServiceCard)}
        </div>

        {advancedServices.length > 0 ? (
          <div className="rounded-lg border border-slate-800 bg-slate-900/60">
            <button
              type="button"
              onClick={() => setAdvancedOpen(value => !value)}
              className="flex w-full items-center justify-between px-5 py-4 text-left transition hover:bg-slate-800/50"
            >
              <span>
                <span className="block text-sm font-semibold text-white">{t('dashboard.advancedServices')}</span>
                <span className="mt-1 block text-xs text-slate-500">{t('dashboard.advancedServicesHint')}</span>
              </span>
              <span className="text-xs font-bold uppercase text-slate-400">
                {advancedOpen ? t('dashboard.collapse') : t('dashboard.expand')}
              </span>
            </button>
            {advancedOpen ? (
              <div className="grid grid-cols-1 gap-4 border-t border-slate-800 p-4 xl:grid-cols-2">
                {advancedServices.map(renderServiceCard)}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
};

const MetricCard: FC<{ label: string; value: string; detail: string }> = ({ label, value, detail }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
    <div className="mt-3 font-mono text-3xl font-bold text-white">{value}</div>
    <div className="mt-2 text-xs text-slate-500">{detail}</div>
  </div>
);

const SignalTile: FC<{ label: string; value: string; detail?: string }> = ({ label, value, detail }) => (
  <div className="rounded-md border border-slate-800 bg-slate-950/70 p-4">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-2 font-mono text-sm text-slate-200">{value}</div>
    {detail ? <div className="mt-2 text-xs leading-5 text-slate-500">{detail}</div> : null}
  </div>
);

const StatusPill: FC<{ status: ServiceStatus }> = ({ status }) => (
  <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase ${STATUS_STYLES[status]}`}>
    {status}
  </span>
);

function formatPercent(value: number | null | undefined): string {
  return typeof value === 'number' ? `${value.toFixed(1)}%` : '-';
}

function formatDuration(value: number | null | undefined): string {
  if (typeof value !== 'number') return '-';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = Math.floor(value % 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function recommendationClassName(level: 'info' | 'warning' | 'critical'): string {
  if (level === 'critical') return 'border-rose-500/30 bg-rose-500/10 text-rose-200';
  if (level === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  return 'border-sky-500/30 bg-sky-500/10 text-sky-200';
}

function formatGpuDetail(gpu: DashboardStatus['system']['gpu'] | undefined): string | undefined {
  if (!gpu) return undefined;
  if (gpu.controllers.length === 0) return gpu.detail;
  return gpu.controllers.map(controller => {
    const parts = [controller.model];
    if (controller.vramMb !== null) parts.push(`${controller.vramMb} MB`);
    if (controller.utilizationGpu !== null) parts.push(`${controller.utilizationGpu}%`);
    if (controller.temperatureGpu !== null) parts.push(`${controller.temperatureGpu}C`);
    return parts.join(' · ');
  }).join('\n');
}
