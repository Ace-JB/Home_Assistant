import { type FC, type ReactNode, useEffect, useMemo, useState } from 'react';
import { IconDashboard, IconVideo, IconBell, IconSettings, IconZap, IconMemory, IconMic, IconLogs, IconPower } from './Icons';
import { useI18n } from '../i18n';
import type {
  AssistantRuntimeOptionalService,
  AssistantRuntimeStartInput,
  AssistantRuntimeStatus,
  AssistantRuntimeStatusValue,
  AssistantRuntimeTask,
  AssistantRuntimeTaskStatus,
} from '../types/assistantRuntime';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: 'dashboard' | 'live' | 'memory' | 'voice' | 'logs') => void;
  runtime: AssistantRuntimeStatus;
  runtimeAvailable: boolean;
  runtimeBusy: boolean;
  runtimeError: string;
  onRuntimeStart: (input?: AssistantRuntimeStartInput) => Promise<void>;
  onRuntimeStop: () => Promise<void>;
}

type NavTab = 'dashboard' | 'live' | 'memory' | 'voice' | 'logs';
type OptionalTool = {
  id: AssistantRuntimeOptionalService;
  taskId: AssistantRuntimeTask['id'];
  labelKey: 'sidebar.runtime.tool.cosyvoice' | 'sidebar.runtime.tool.liveVision' | 'sidebar.runtime.tool.voiceSeparation';
  descriptionKey: 'sidebar.runtime.tool.cosyvoiceDesc' | 'sidebar.runtime.tool.liveVisionDesc' | 'sidebar.runtime.tool.voiceSeparationDesc';
};

const OPTIONAL_TOOLS: OptionalTool[] = [
  {
    id: 'cosyvoice',
    taskId: 'cosyvoice',
    labelKey: 'sidebar.runtime.tool.cosyvoice',
    descriptionKey: 'sidebar.runtime.tool.cosyvoiceDesc',
  },
  {
    id: 'live-vision',
    taskId: 'live-vision',
    labelKey: 'sidebar.runtime.tool.liveVision',
    descriptionKey: 'sidebar.runtime.tool.liveVisionDesc',
  },
  {
    id: 'voice-separation',
    taskId: 'voice-separation',
    labelKey: 'sidebar.runtime.tool.voiceSeparation',
    descriptionKey: 'sidebar.runtime.tool.voiceSeparationDesc',
  },
];

export const Sidebar: FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  runtime,
  runtimeAvailable,
  runtimeBusy,
  runtimeError,
  onRuntimeStart,
  onRuntimeStop,
}) => {
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [showOperation, setShowOperation] = useState(false);
  const [currentOperationType, setCurrentOperationType] = useState<'start' | 'stop' | null>(null);
  const [selectedTools, setSelectedTools] = useState<Set<AssistantRuntimeOptionalService>>(new Set());
  const shouldStop = runtime.status === 'running' || runtime.status === 'degraded';
  const actionInProgress = executing || runtime.status === 'starting' || runtime.status === 'stopping';
  const fallbackOperationType = shouldStop ? 'stop' : 'start';
  const runtimeOperation = runtime.operation;
  const expectedOperationType = currentOperationType ?? runtimeOperation?.type ?? null;
  const operation = showOperation && runtimeOperation && runtimeOperation.type === expectedOperationType ? runtimeOperation : null;
  const operationType = currentOperationType ?? operation?.type ?? fallbackOperationType;
  const operationTasks = operation?.tasks.filter(task => task.selected) ?? [];
  const operationDone = Boolean(operation && operation.phase !== 'running');
  const startPreviewTasks = useMemo(
    () => buildStartPreviewTasks(runtime.tasks, selectedTools),
    [runtime.tasks, selectedTools],
  );
  const stopPreviewTasks = useMemo(
    () => runtime.tasks.filter(task => task.selected && task.status !== 'skipped'),
    [runtime.tasks],
  );
  const visibleTasks = actionInProgress || operationDone
    ? operationTasks.length > 0 ? operationTasks : operationType === 'stop' ? stopPreviewTasks : startPreviewTasks
    : operationType === 'stop'
      ? stopPreviewTasks
      : startPreviewTasks;

  const navItems: Array<{ tab: NavTab; label: string; icon: ReactNode; requiresRuntime: boolean }> = [
    { tab: 'dashboard', label: t('sidebar.dashboard'), icon: <IconDashboard />, requiresRuntime: false },
    { tab: 'live', label: t('sidebar.live'), icon: <IconVideo />, requiresRuntime: true },
    { tab: 'memory', label: t('sidebar.memory'), icon: <IconMemory />, requiresRuntime: true },
    { tab: 'voice', label: t('sidebar.voice'), icon: <IconMic />, requiresRuntime: true },
    { tab: 'logs', label: t('sidebar.logs'), icon: <IconLogs />, requiresRuntime: true },
  ];

  useEffect(() => {
    if (!confirmOpen) {
      setExecuting(false);
      setShowOperation(false);
      setCurrentOperationType(null);
      setSelectedTools(new Set());
    }
  }, [confirmOpen]);

  async function confirmRuntimeAction() {
    if (runtimeBusy || actionInProgress) return;
    const nextOperationType = shouldStop ? 'stop' : 'start';
    setExecuting(true);
    setShowOperation(true);
    setCurrentOperationType(nextOperationType);
    try {
      if (shouldStop) {
        await onRuntimeStop();
      } else {
        await onRuntimeStart({
          mode: selectedTools.has('live-vision') ? 'full' : 'minimal',
          optionalServices: [...selectedTools],
        });
      }
    } finally {
      setExecuting(false);
    }
  }

  function toggleOptionalTool(id: AssistantRuntimeOptionalService) {
    setSelectedTools(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <aside className="w-[260px] bg-slate-900 border-r border-slate-800 flex flex-col flex-shrink-0">
      <div className="p-6 flex items-center gap-3">
        <div className="bg-indigo-600 p-2 rounded-lg flex items-center justify-center">
          <IconZap />
        </div>
        <span className="font-bold text-xl text-white">AI Agent</span>
      </div>

      <nav className="flex-1 px-4 space-y-2 mt-4">
        {navItems.map((item) => {
          const disabled = item.requiresRuntime && !runtimeAvailable;
          return (
            <button
              key={item.tab}
              type="button"
              disabled={disabled}
              onClick={() => setActiveTab(item.tab)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                activeTab === item.tab
                  ? 'bg-indigo-600 text-white'
                  : disabled
                    ? 'text-slate-600 cursor-not-allowed opacity-60'
                    : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              {item.icon}
              <span className="text-sm font-medium">{item.label}</span>
            </button>
          );
        })}
        <div className="flex items-center gap-3 px-4 py-3 text-slate-500 opacity-50 cursor-not-allowed">
          <IconBell />
          <span className="text-sm font-medium">{t('sidebar.history')}</span>
        </div>
        <div className="flex items-center gap-3 px-4 py-3 text-slate-500 opacity-50 cursor-not-allowed">
          <IconSettings />
          <span className="text-sm font-medium">{t('sidebar.settings')}</span>
        </div>
      </nav>

      <div className="m-4">
        <button
          type="button"
          disabled={actionInProgress}
          onClick={() => setConfirmOpen(true)}
          className={`w-full rounded-lg border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-70 ${runtimeControlClass(runtime.status)}`}
        >
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-950/50">
              <IconPower />
            </span>
            <span className="text-sm font-semibold text-slate-100">{t(runtimeStatusLabelKey(runtime.status))}</span>
          </div>
        </button>
        {runtimeError ? <p className="mt-2 text-[11px] leading-4 text-rose-300">{runtimeError}</p> : null}
      </div>

      {confirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4">
          <div className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className={`mt-1 flex h-8 w-8 items-center justify-center rounded-md ${shouldStop ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
                <IconPower />
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">
                  {operationDone
                    ? t(operation?.phase === 'failed' ? 'sidebar.runtime.operationFailedTitle' : 'sidebar.runtime.operationDoneTitle')
                    : t(shouldStop ? 'sidebar.runtime.confirmStopTitle' : 'sidebar.runtime.confirmStartTitle')}
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  {t(operationType === 'stop' ? 'sidebar.runtime.confirmStopBody' : 'sidebar.runtime.confirmStartBody')}
                </p>
              </div>
            </div>

            {!shouldStop && !actionInProgress && !operationDone ? (
              <div className="mt-5 rounded-md border border-slate-800 bg-slate-950/50 p-4">
                <div className="text-xs font-bold uppercase tracking-widest text-slate-500">{t('sidebar.runtime.moreTools')}</div>
                <div className="mt-3 space-y-3">
                  {OPTIONAL_TOOLS.map(tool => (
                    <label key={tool.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-800 bg-slate-900/70 p-3 transition hover:border-slate-600">
                      <input
                        type="checkbox"
                        checked={selectedTools.has(tool.id)}
                        onChange={() => toggleOptionalTool(tool.id)}
                        className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-950"
                      />
                      <span>
                        <span className="block text-sm font-semibold text-slate-100">{t(tool.labelKey)}</span>
                        <span className="mt-1 block text-xs leading-5 text-slate-500">{t(tool.descriptionKey)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-5 space-y-2">
              <div className="text-xs font-bold uppercase tracking-widest text-slate-500">
                {operationType === 'stop' ? t('sidebar.runtime.stopList') : t('sidebar.runtime.startList')}
              </div>
              {visibleTasks.map(task => (
                <RuntimeTaskRow key={task.id} task={task} statusLabel={t(runtimeTaskStatusKey(task.status))} />
              ))}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              {actionInProgress ? null : (
                <button
                  type="button"
                  onClick={() => setConfirmOpen(false)}
                  className="rounded-md border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
                >
                  {operationDone ? t('sidebar.runtime.done') : t('sidebar.runtime.cancel')}
                </button>
              )}
              {!operationDone ? (
                <button
                  type="button"
                  disabled={runtimeBusy || actionInProgress}
                  onClick={() => void confirmRuntimeAction()}
                  className={`rounded-md px-3 py-2 text-xs font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-60 ${shouldStop ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}
                >
                  {runtimeBusy || actionInProgress ? t('sidebar.runtime.working') : t(shouldStop ? 'sidebar.runtime.confirmStop' : 'sidebar.runtime.confirmStart')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
};

const RuntimeTaskRow: FC<{ task: AssistantRuntimeTask; statusLabel: string }> = ({ task, statusLabel }) => (
  <div className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
    <div className="min-w-0">
      <div className="truncate text-sm font-medium text-slate-200">{task.label}</div>
      {task.message ? <div className="mt-1 text-xs text-rose-300">{task.message}</div> : null}
    </div>
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${runtimeTaskStatusClass(task.status)}`}>
      {statusLabel}
    </span>
  </div>
);

function buildStartPreviewTasks(
  tasks: AssistantRuntimeTask[],
  selectedTools: Set<AssistantRuntimeOptionalService>,
): AssistantRuntimeTask[] {
  return tasks
    .map(task => {
      const selected = task.required || selectedTools.has(optionalServiceForTask(task.id));
      return { ...task, selected, status: selected ? 'pending' as const : 'skipped' as const };
    })
    .filter(task => task.selected);
}

function optionalServiceForTask(taskId: AssistantRuntimeTask['id']): AssistantRuntimeOptionalService {
  if (taskId === 'cosyvoice') return 'cosyvoice';
  if (taskId === 'live-vision' || taskId === 'webrtc') return 'live-vision';
  if (taskId === 'voice-separation') return 'voice-separation';
  return 'live-vision';
}

function runtimeControlClass(status: AssistantRuntimeStatusValue): string {
  if (status === 'running') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:border-emerald-400';
  if (status === 'degraded') return 'border-orange-500/40 bg-orange-500/10 text-orange-200 hover:border-orange-400';
  if (status === 'starting' || status === 'stopping') return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  if (status === 'error') return 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:border-rose-400';
  return 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:border-rose-400';
}

function runtimeTaskStatusClass(status: AssistantRuntimeTaskStatus): string {
  if (status === 'ready') return 'bg-emerald-500/15 text-emerald-300';
  if (status === 'running' || status === 'stopping') return 'bg-amber-500/15 text-amber-300';
  if (status === 'failed') return 'bg-rose-500/15 text-rose-300';
  if (status === 'stopped' || status === 'skipped') return 'bg-slate-800 text-slate-400';
  return 'bg-slate-800 text-slate-300';
}

function runtimeTaskStatusKey(status: AssistantRuntimeTaskStatus) {
  if (status === 'running') return 'sidebar.runtime.task.running';
  if (status === 'ready') return 'sidebar.runtime.task.ready';
  if (status === 'failed') return 'sidebar.runtime.task.failed';
  if (status === 'skipped') return 'sidebar.runtime.task.skipped';
  if (status === 'stopping') return 'sidebar.runtime.task.stopping';
  if (status === 'stopped') return 'sidebar.runtime.task.stopped';
  return 'sidebar.runtime.task.pending';
}

function runtimeStatusLabelKey(status: AssistantRuntimeStatusValue) {
  if (status === 'starting') return 'sidebar.runtime.starting';
  if (status === 'running') return 'sidebar.runtime.running';
  if (status === 'stopping') return 'sidebar.runtime.stopping';
  if (status === 'degraded') return 'sidebar.runtime.degraded';
  if (status === 'error') return 'sidebar.runtime.error';
  return 'sidebar.runtime.stopped';
}
