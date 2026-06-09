import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type Language } from '../i18n';
import { choosePipelineIdAfterLogRefresh } from './logsNavigation';

type PipelineKind = 'system' | 'conversation';
type PipelineStage = 'wake' | 'asr' | 'intent' | 'context' | 'memory' | 'vision' | 'model' | 'tool' | 'tts' | 'service' | 'summary';
type PipelineLevel = 'debug' | 'info' | 'warn' | 'error';
type PipelineStatus = 'running' | 'completed' | 'failed';

type TaskTiming = {
  key: string;
  label: string;
  durationMs: number;
  detail?: string;
};

export type PipelineRun = {
  id: string;
  kind: PipelineKind;
  status: PipelineStatus;
  title: string;
  conversationId?: string;
  userCommand?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  severity: PipelineLevel;
  summary?: unknown;
  metadata?: unknown;
  eventCount: number;
  incidentCount: number;
  modelCallCount: number;
};

type PipelineEvent = {
  id: string;
  pipelineId: string;
  ts: number;
  stage: PipelineStage;
  eventType: string;
  level: PipelineLevel;
  title: string;
  message?: string;
  detail?: string;
  timings?: TaskTiming[];
  metadata?: unknown;
};

type ModelCallRecord = {
  id: string;
  pipelineId: string;
  eventId?: string;
  ts: number;
  stage: PipelineStage;
  scope: string;
  modelId: string;
  status: 'started' | 'complete' | 'failed';
  durationMs?: number;
  inputChars?: number;
  outputChars?: number;
  promptPreview?: string;
  outputPreview?: string;
  error?: string;
  metadata?: unknown;
};

type PipelineIncident = {
  id: string;
  pipelineId: string;
  eventId?: string;
  ts: number;
  stage: PipelineStage;
  severity: 'warn' | 'error';
  reason: string;
  inputSnapshot?: string;
  outputSnapshot?: string;
  recommendedAction?: string;
  metadata?: unknown;
  summary?: string;
};

type PipelineDetail = PipelineRun & {
  events: PipelineEvent[];
};

type ModelCallDetail = {
  modelCall: ModelCallRecord;
  pipeline?: PipelineRun | null;
  incidents?: PipelineIncident[];
};

type IncidentDetail = {
  incident: PipelineIncident;
  pipeline?: PipelineRun | null;
};

type MetricStats = {
  count: number;
  avgMs?: number;
  p50Ms?: number;
  p90Ms?: number;
  minMs?: number;
  maxMs?: number;
};

type BenchmarkScenarioSummary = {
  runId: string;
  variantId: string;
  scenarioId: string;
  backend?: string;
  textModel?: string;
  visionModel?: string;
  ctxSize?: number;
  total: number;
  completed: number;
  failed: number;
  successRate: number;
  pipelineDuration: MetricStats;
  stageDurations: Record<string, MetricStats>;
  modelDurations: Record<string, MetricStats & { modelId: string; inputChars: number; outputChars: number; charsPerSecond?: number; coldStarts: number }>;
  inputChars: number;
  outputChars: number;
  charsPerSecond?: number;
  coldStarts: number;
  incidentCount: number;
  samplePipelineIds: string[];
  sampleModelCallIds: string[];
};

type BenchmarkRunSummary = {
  runId: string;
  variants: string[];
  startedAt?: number;
  completedAt?: number;
  scenarioSummaries: BenchmarkScenarioSummary[];
};

type BenchmarkRunListItem = {
  runId: string;
  variants: string[];
  scenarioCount: number;
  pipelineCount: number;
  startedAt?: number;
  completedAt?: number;
};

type LogsTab = 'pipelines' | 'model' | 'incidents' | 'benchmarks';

type ModelReturnContext = {
  pipelineId: string;
};

type ModelCallRef = {
  modelCallId: string;
  scope?: string;
  modelId?: string;
  status?: string;
  inputChars?: number;
  outputChars?: number;
};

type IncidentRef = {
  incidentId: string;
  severity?: 'warn' | 'error';
  reason?: string;
};

const PAGE_SIZE = 200;

export const LogsView: FC = () => {
  const { language } = useI18n();
  const [activeTab, setActiveTab] = useState<LogsTab>('pipelines');
  const [pipelines, setPipelines] = useState<PipelineRun[]>([]);
  const [modelCalls, setModelCalls] = useState<ModelCallRecord[]>([]);
  const [incidents, setIncidents] = useState<PipelineIncident[]>([]);
  const [benchmarkRuns, setBenchmarkRuns] = useState<BenchmarkRunListItem[]>([]);
  const [selected, setSelected] = useState<PipelineDetail | null>(null);
  const [selectedModelCallDetail, setSelectedModelCallDetail] = useState<ModelCallDetail | null>(null);
  const [selectedIncidentDetail, setSelectedIncidentDetail] = useState<IncidentDetail | null>(null);
  const [selectedBenchmarkRun, setSelectedBenchmarkRun] = useState<BenchmarkRunSummary | null>(null);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [selectedModelCallId, setSelectedModelCallId] = useState<string | null>(null);
  const [selectedBenchmarkRunId, setSelectedBenchmarkRunId] = useState<string | null>(null);
  const [modelReturnContext, setModelReturnContext] = useState<ModelReturnContext | null>(null);
  const pendingModelCallIdRef = useRef<string | null>(null);
  const pendingPipelineIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const detailPanelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void loadLogs();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'model' || !selectedModelCallId || !selectedModelCallDetail) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(domId('model-call-list', selectedModelCallId))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      detailPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, selectedModelCallDetail, selectedModelCallId]);

  const visiblePipelines = useMemo(() => pipelines, [pipelines]);
  const availableModelCallIds = useMemo(() => new Set(modelCalls.map(call => call.id)), [modelCalls]);
  const availableIncidentIds = useMemo(() => new Set(incidents.map(incident => incident.id)), [incidents]);

  function handleTabChange(tab: LogsTab) {
    setActiveTab(tab);
    setSelected(null);
    setSelectedModelCallDetail(null);
    setSelectedIncidentDetail(null);
    setSelectedBenchmarkRun(null);
    setSelectedIncidentId(null);
    setSelectedModelCallId(null);
    setSelectedBenchmarkRunId(null);
    setModelReturnContext(null);
  }

  async function loadLogs() {
    setLoading(true);
    try {
      const [pipelineResponse, modelResponse, incidentResponse, benchmarkResponse] = await Promise.all([
        fetch(`/api/pipeline-logs?limit=${PAGE_SIZE}`),
        fetch(`/api/pipeline-model-calls?limit=${PAGE_SIZE}`),
        fetch(`/api/pipeline-incidents?limit=${PAGE_SIZE}`),
        fetch('/api/benchmarks/runs'),
      ]);
      if (!pipelineResponse.ok) throw new Error(`Pipeline HTTP ${pipelineResponse.status}`);
      if (!modelResponse.ok) throw new Error(`Model HTTP ${modelResponse.status}`);
      if (!incidentResponse.ok) throw new Error(`Incident HTTP ${incidentResponse.status}`);
      if (!benchmarkResponse.ok) throw new Error(`Benchmark HTTP ${benchmarkResponse.status}`);
      const pipelineData = await pipelineResponse.json() as { pipelines: PipelineRun[] };
      const modelData = await modelResponse.json() as { modelCalls: ModelCallRecord[] };
      const incidentData = await incidentResponse.json() as { incidents: PipelineIncident[] };
      const benchmarkData = await benchmarkResponse.json() as { runs: BenchmarkRunListItem[] };
      setPipelines(pipelineData.pipelines);
      setModelCalls(modelData.modelCalls);
      setIncidents(incidentData.incidents);
      setBenchmarkRuns(benchmarkData.runs);
      const visiblePipelineData = pipelineData.pipelines;
      if (activeTab === 'pipelines') {
        const nextPipelineId = choosePipelineIdAfterLogRefresh(visiblePipelineData, pendingPipelineIdRef.current, selected?.id ?? null);
        if (nextPipelineId) {
          await selectPipeline(nextPipelineId);
          pendingPipelineIdRef.current = null;
        } else {
          setSelected(null);
          setSelectedIncidentId(null);
          setSelectedModelCallId(null);
        }
      } else if (activeTab === 'model') {
        const targetModelCallId = pendingModelCallIdRef.current ?? selectedModelCallId;
        const selectedModelCall = targetModelCallId
          ? modelData.modelCalls.find(call => call.id === targetModelCallId)
          : null;
        const selectedModelCallFallback = selectedModelCallId
          ? modelData.modelCalls.find(call => call.id === selectedModelCallId)
          : null;
        if (selectedModelCall ?? selectedModelCallFallback) {
          await selectModelCall((selectedModelCall ?? selectedModelCallFallback)!.id, { preserveReturnContext: true });
          pendingModelCallIdRef.current = null;
        } else {
          setSelected(null);
          setSelectedModelCallDetail(null);
          setSelectedIncidentId(null);
          setSelectedModelCallId(null);
          setModelReturnContext(null);
        }
      } else if (activeTab === 'incidents') {
        const selectedIncident = selectedIncidentId
          ? incidentData.incidents.find(incident => incident.id === selectedIncidentId)
          : null;
        if (selectedIncident) {
          await selectIncident(selectedIncident.id);
        } else {
          setSelected(null);
          setSelectedModelCallDetail(null);
          setSelectedIncidentDetail(null);
          setSelectedIncidentId(null);
          setSelectedModelCallId(null);
        }
      } else if (activeTab === 'benchmarks') {
        const selectedRun = selectedBenchmarkRunId
          ? benchmarkData.runs.find(run => run.runId === selectedBenchmarkRunId)
          : null;
        const nextRunId = selectedRun?.runId ?? benchmarkData.runs[0]?.runId;
        if (nextRunId) {
          await selectBenchmarkRun(nextRunId);
        } else {
          setSelectedBenchmarkRun(null);
          setSelectedBenchmarkRunId(null);
        }
      }
      setError('');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load pipeline logs');
    } finally {
      setLoading(false);
    }
  }

  async function selectPipeline(pipelineId: string, incidentId: string | null = null, modelCallId: string | null = null) {
    const response = await fetch(`/api/pipeline-logs/${encodeURIComponent(pipelineId)}`);
    if (!response.ok) {
      setError(`Pipeline detail HTTP ${response.status}`);
      return;
    }
    const data = await response.json() as { pipeline: PipelineRun; events: PipelineEvent[] };
    setSelected({ ...data.pipeline, events: data.events });
    setSelectedModelCallDetail(null);
    setSelectedIncidentDetail(null);
    setSelectedIncidentId(incidentId);
    setSelectedModelCallId(modelCallId);
    setError('');
  }

  async function selectModelCall(modelCallId: string, options: { preserveReturnContext?: boolean } = {}) {
    const response = await fetch(`/api/pipeline-model-calls/${encodeURIComponent(modelCallId)}`);
    if (!response.ok) {
      setSelectedModelCallDetail(null);
      setSelectedModelCallId(null);
      setError(`Model call detail HTTP ${response.status}`);
      return;
    }
    const data = await response.json() as ModelCallDetail;
    setSelected(null);
    setSelectedModelCallDetail(data);
    setSelectedIncidentDetail(null);
    setSelectedIncidentId(null);
    setSelectedModelCallId(data.modelCall.id);
    if (!options.preserveReturnContext) {
      setModelReturnContext(null);
    }
    setError('');
  }

  async function selectIncident(incidentId: string) {
    const response = await fetch(`/api/pipeline-incidents/${encodeURIComponent(incidentId)}`);
    if (!response.ok) {
      setSelectedIncidentDetail(null);
      setSelectedIncidentId(null);
      setError(`Incident detail HTTP ${response.status}`);
      return;
    }
    const data = await response.json() as IncidentDetail;
    setSelected(null);
    setSelectedModelCallDetail(null);
    setSelectedIncidentDetail(data);
    setSelectedIncidentId(data.incident.id);
    setSelectedModelCallId(null);
    setModelReturnContext(null);
    setError('');
  }

  async function selectBenchmarkRun(runId: string) {
    const response = await fetch(`/api/benchmarks/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) {
      setSelectedBenchmarkRun(null);
      setSelectedBenchmarkRunId(null);
      setError(`Benchmark detail HTTP ${response.status}`);
      return;
    }
    const data = await response.json() as { run: BenchmarkRunSummary };
    setSelected(null);
    setSelectedModelCallDetail(null);
    setSelectedIncidentDetail(null);
    setSelectedBenchmarkRun(data.run);
    setSelectedBenchmarkRunId(data.run.runId);
    setError('');
  }

  async function openModelCall(modelCallId: string, pipelineId: string) {
    pendingModelCallIdRef.current = modelCallId;
    setModelReturnContext({ pipelineId });
    setActiveTab('model');
    await selectModelCall(modelCallId, { preserveReturnContext: true });
  }

  async function openPipelineFromBenchmark(pipelineId: string) {
    setActiveTab('pipelines');
    await selectPipeline(pipelineId);
    window.requestAnimationFrame(() => {
      detailPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      document.getElementById(domId('pipeline-list', pipelineId))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  async function openModelCallFromBenchmark(modelCallId: string) {
    setActiveTab('model');
    await selectModelCall(modelCallId);
  }

  async function openIncident(incidentId: string) {
    setActiveTab('incidents');
    await selectIncident(incidentId);
  }

  async function returnToPipelineFromModelCall(detail: ModelCallDetail) {
    const pipelineId = modelReturnContext?.pipelineId ?? detail.pipeline?.id ?? detail.modelCall.pipelineId;
    setModelReturnContext(null);
    pendingPipelineIdRef.current = pipelineId;
    setActiveTab('pipelines');
    await selectPipeline(pipelineId);
    window.requestAnimationFrame(() => {
      detailPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      document.getElementById(domId('pipeline-list', pipelineId))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  async function openPipelineFromIncident(detail: IncidentDetail) {
    const pipelineId = detail.pipeline?.id ?? detail.incident.pipelineId;
    pendingPipelineIdRef.current = pipelineId;
    setActiveTab('pipelines');
    await selectPipeline(pipelineId, detail.incident.id);
    window.requestAnimationFrame(() => {
      detailPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      document.getElementById(domId('pipeline-list', pipelineId))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  async function deleteSelected() {
    if (activeTab === 'model' && selectedModelCallDetail) {
      const response = await fetch(`/api/pipeline-model-calls/${encodeURIComponent(selectedModelCallDetail.modelCall.id)}`, { method: 'DELETE' });
      if (!response.ok) {
        setError(`Delete model call HTTP ${response.status}`);
        return;
      }
      setSelectedModelCallDetail(null);
      setSelectedModelCallId(null);
      await loadLogs();
      return;
    }
    if (activeTab === 'incidents' && selectedIncidentDetail) {
      const response = await fetch(`/api/pipeline-incidents/${encodeURIComponent(selectedIncidentDetail.incident.id)}`, { method: 'DELETE' });
      if (!response.ok) {
        setError(`Delete incident HTTP ${response.status}`);
        return;
      }
      setSelectedIncidentDetail(null);
              setSelectedIncidentId(null);
              setSelectedBenchmarkRun(null);
              setSelectedBenchmarkRunId(null);
              await loadLogs();
              return;
    }
    if (!selected) return;
    const response = await fetch(`/api/pipeline-logs/${encodeURIComponent(selected.id)}`, { method: 'DELETE' });
    if (!response.ok) {
      setError(`Delete HTTP ${response.status}`);
      return;
    }
    setSelected(null);
    await loadLogs();
  }

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-1 gap-5 animate-in fade-in duration-500 xl:grid-cols-[420px_minmax(0,1fr)]">
      <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-5 xl:sticky xl:top-4 xl:max-h-[calc(100vh-8rem)] xl:overflow-y-auto">
        <div className="sticky top-0 z-10 -mx-5 -mt-5 border-b border-slate-800 bg-slate-900/95 px-5 pb-4 pt-5 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase text-slate-500">Pipeline logs</div>
              <h3 className="mt-1 text-lg font-bold text-white">{language === 'zh' ? '流程日志' : 'Logs'}</h3>
            </div>
            <button
              type="button"
              onClick={() => void loadLogs()}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              {language === 'zh' ? '刷新' : 'Refresh'}
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            {(['pipelines', 'model', 'incidents', 'benchmarks'] as LogsTab[]).map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => handleTabChange(tab)}
                className={`rounded-md border p-3 text-left text-xs font-semibold transition ${
                  activeTab === tab ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-100' : 'border-slate-800 bg-slate-950/70 text-slate-300 hover:border-slate-700'
                }`}
              >
                <div>{tabLabel(tab, language)}</div>
                <div className="mt-1 text-[11px] font-normal text-slate-500">{tabCount(tab, pipelines, modelCalls, incidents, benchmarkRuns)}</div>
              </button>
            ))}
          </div>

          <div className="mt-4 text-xs text-slate-500">{loading ? (language === 'zh' ? '加载中...' : 'Loading...') : `${visibleCount(activeTab, visiblePipelines, modelCalls, incidents, benchmarkRuns)} items`}</div>
          {error ? <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">{error}</div> : null}
        </div>

        <div className="mt-4 space-y-2">
          {activeTab === 'benchmarks'
            ? benchmarkRuns.map(run => (
              <BenchmarkRunItem
                key={run.runId}
                run={run}
                language={language}
                selected={selectedBenchmarkRunId === run.runId}
                onOpen={() => void selectBenchmarkRun(run.runId)}
              />
            ))
            : activeTab === 'model'
            ? modelCalls.map(call => (
              <ModelCallItem
                key={call.id}
                call={call}
                language={language}
                selected={selectedModelCallId === call.id}
                onOpen={() => void selectModelCall(call.id)}
              />
              ))
            : activeTab === 'incidents'
              ? incidents.map(incident => (
                <IncidentItem
                  key={incident.id}
                  incident={incident}
                  language={language}
                  selected={selectedIncidentId === incident.id}
                  onOpen={() => void selectIncident(incident.id)}
                />
              ))
              : visiblePipelines.map(pipeline => (
                <PipelineItem
                  key={pipeline.id}
                  pipeline={pipeline}
                  language={language}
                  selected={selected?.id === pipeline.id}
                  onClick={() => void selectPipeline(pipeline.id)}
                />
              ))}
        </div>
      </section>

      <section ref={detailPanelRef} className="min-w-0 rounded-lg border border-slate-800 bg-slate-900/80 p-5 xl:sticky xl:top-4 xl:max-h-[calc(100vh-8rem)] xl:overflow-y-auto">
        {activeTab === 'benchmarks' ? (
          selectedBenchmarkRun ? (
            <BenchmarkRunDetailView
              run={selectedBenchmarkRun}
              language={language}
              onOpenPipeline={(pipelineId) => void openPipelineFromBenchmark(pipelineId)}
              onOpenModelCall={(modelCallId) => void openModelCallFromBenchmark(modelCallId)}
            />
          ) : (
            <div className="flex min-h-[520px] items-center justify-center text-sm text-slate-500">
              {language === 'zh' ? '选择一组 Benchmark 查看对比' : 'Select a benchmark run'}
            </div>
          )
        ) : activeTab === 'model' ? (
          selectedModelCallDetail ? (
            <ModelCallDetailView
              detail={selectedModelCallDetail}
              language={language}
              showPipelineReturn={modelReturnContext !== null || Boolean(selectedModelCallDetail.pipeline)}
              onOpenPipeline={() => void returnToPipelineFromModelCall(selectedModelCallDetail)}
              onOpenIncident={(incidentId) => void openIncident(incidentId)}
              onDelete={() => void deleteSelected()}
            />
          ) : (
            <div className="flex min-h-[520px] items-center justify-center text-sm text-slate-500">
              {language === 'zh' ? '选择一条模型调用查看详情' : 'Select a model call'}
            </div>
          )
        ) : activeTab === 'incidents' ? (
          selectedIncidentDetail ? (
            <IncidentDetailView
              detail={selectedIncidentDetail}
              language={language}
              onOpenPipeline={selectedIncidentDetail.pipeline ? () => void openPipelineFromIncident(selectedIncidentDetail) : undefined}
              onDelete={() => void deleteSelected()}
            />
          ) : (
            <div className="flex min-h-[520px] items-center justify-center text-sm text-slate-500">
              {language === 'zh' ? '选择一条异常复盘查看详情' : 'Select an incident'}
            </div>
          )
        ) : !selected ? (
          <div className="flex min-h-[520px] items-center justify-center text-sm text-slate-500">
            {language === 'zh' ? '选择一条 pipeline 查看详情' : 'Select a pipeline'}
          </div>
        ) : (
          <PipelineDetailView
            pipeline={selected}
            language={language}
            availableModelCallIds={availableModelCallIds}
            availableIncidentIds={availableIncidentIds}
            onOpenModelCall={(modelCallId, pipelineId) => void openModelCall(modelCallId, pipelineId)}
            onOpenIncident={(incidentId) => void openIncident(incidentId)}
            onDelete={() => void deleteSelected()}
          />
        )}
      </section>
    </div>
  );
};

const PipelineItem: FC<{ pipeline: PipelineRun; language: Language; selected: boolean; onClick: () => void }> = ({ pipeline, language, selected, onClick }) => (
  <button
    id={domId('pipeline-list', pipeline.id)}
    type="button"
    onClick={onClick}
    className={`w-full rounded-md border p-3 text-left transition ${
      selected ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
    }`}
  >
    <div className="flex items-center justify-between gap-2">
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${levelClass(pipeline.severity)}`}>{pipeline.severity}</span>
      <span className="font-mono text-[11px] text-slate-500">{formatDate(pipeline.startedAt, language)}</span>
    </div>
    <div className="mt-2 text-sm font-semibold text-slate-100">{pipeline.title}</div>
    <div className="mt-1 text-xs text-slate-500">{kindLabel(pipeline.kind, language)} · {pipeline.status}</div>
    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
      <span>{pipeline.eventCount} events</span>
      <span>{pipeline.modelCallCount} model</span>
      <span>{pipeline.incidentCount} incidents</span>
      {pipeline.durationMs !== undefined ? <span>{formatDurationMs(pipeline.durationMs)}</span> : null}
    </div>
  </button>
);

const ModelCallItem: FC<{ call: ModelCallRecord; language: Language; selected: boolean; onOpen: () => void }> = ({ call, language, selected, onOpen }) => (
  <button
    id={domId('model-call-list', call.id)}
    type="button"
    onClick={onOpen}
    className={`w-full rounded-md border p-3 text-left transition ${
      selected ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
    }`}
  >
    <div className="flex items-center justify-between gap-2">
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${call.status === 'failed' ? levelClass('error') : levelClass('info')}`}>{call.status}</span>
      <span className="font-mono text-[11px] text-slate-500">{formatDate(call.ts, language)}</span>
    </div>
    <div className="mt-2 text-sm font-semibold text-slate-100">{call.scope}</div>
    <div className="mt-1 text-xs text-slate-500">{call.modelId} · {call.stage}</div>
    <div className="mt-2 text-xs text-slate-400">{call.durationMs !== undefined ? formatDurationMs(call.durationMs) : '-'} · in {call.inputChars ?? 0} · out {call.outputChars ?? 0}</div>
  </button>
);

const IncidentItem: FC<{ incident: PipelineIncident; language: Language; selected: boolean; onOpen: () => void }> = ({ incident, language, selected, onOpen }) => (
  <button
    type="button"
    onClick={onOpen}
    className={`w-full rounded-md border p-3 text-left transition ${
      selected ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
    }`}
  >
    <div className="flex items-center justify-between gap-2">
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${levelClass(incident.severity)}`}>{incident.severity}</span>
      <span className="font-mono text-[11px] text-slate-500">{formatDate(incident.ts, language)}</span>
    </div>
    <div className="mt-2 text-sm font-semibold text-slate-100">{incident.reason}</div>
    <div className="mt-1 text-xs text-slate-500">{incident.stage}</div>
    <div className="mt-2 line-clamp-2 text-xs text-slate-400">{incident.recommendedAction || incident.outputSnapshot || '-'}</div>
  </button>
);

const BenchmarkRunItem: FC<{ run: BenchmarkRunListItem; language: Language; selected: boolean; onOpen: () => void }> = ({ run, language, selected, onOpen }) => (
  <button
    type="button"
    onClick={onOpen}
    className={`w-full rounded-md border p-3 text-left transition ${
      selected ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
    }`}
  >
    <div className="flex items-center justify-between gap-2">
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">bench</span>
      <span className="font-mono text-[11px] text-slate-500">{run.startedAt ? formatDate(run.startedAt, language) : '-'}</span>
    </div>
    <div className="mt-2 break-all text-sm font-semibold text-slate-100">{run.runId}</div>
    <div className="mt-1 text-xs text-slate-500">{run.variants.join(', ') || '-'}</div>
    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
      <span>{run.scenarioCount} scenarios</span>
      <span>{run.pipelineCount} pipelines</span>
    </div>
  </button>
);

const BenchmarkRunDetailView: FC<{
  run: BenchmarkRunSummary;
  language: Language;
  onOpenPipeline: (pipelineId: string) => void;
  onOpenModelCall: (modelCallId: string) => void;
}> = ({ run, language, onOpenPipeline, onOpenModelCall }) => (
  <div className="space-y-5">
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-bold uppercase text-emerald-300">benchmark</span>
        {run.variants.map(variant => (
          <span key={variant} className="rounded-full bg-slate-800 px-2.5 py-1 text-[10px] font-bold uppercase text-slate-300">{variant}</span>
        ))}
      </div>
      <h3 className="mt-3 break-all text-xl font-bold text-white">{run.runId}</h3>
    </div>

    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <InfoBlock label="Started" value={run.startedAt ? formatDate(run.startedAt, language) : '-'} />
      <InfoBlock label="Completed" value={run.completedAt ? formatDate(run.completedAt, language) : '-'} />
      <InfoBlock label="Scenarios" value={String(run.scenarioSummaries.length)} />
    </div>

    <div className="rounded-md border border-slate-800 bg-slate-950/70 p-4">
      <div className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-500">{language === 'zh' ? '聚合结果' : 'Aggregates'}</div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-xs">
          <thead className="text-[10px] uppercase text-slate-500">
            <tr>
              <th className="whitespace-nowrap px-3 py-2">Variant</th>
              <th className="whitespace-nowrap px-3 py-2">Scenario</th>
              <th className="whitespace-nowrap px-3 py-2">Success</th>
              <th className="whitespace-nowrap px-3 py-2">Avg</th>
              <th className="whitespace-nowrap px-3 py-2">P50</th>
              <th className="whitespace-nowrap px-3 py-2">P90</th>
              <th className="whitespace-nowrap px-3 py-2">Chars/s</th>
              <th className="whitespace-nowrap px-3 py-2">Cold</th>
              <th className="whitespace-nowrap px-3 py-2">Open</th>
            </tr>
          </thead>
          <tbody>
            {run.scenarioSummaries.map(summary => (
              <BenchmarkSummaryRow
                key={`${summary.variantId}-${summary.scenarioId}`}
                summary={summary}
                onOpenPipeline={onOpenPipeline}
                onOpenModelCall={onOpenModelCall}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>

    {run.scenarioSummaries.map(summary => (
      <BenchmarkStagePanel key={`${summary.variantId}-${summary.scenarioId}-stages`} summary={summary} />
    ))}
  </div>
);

const BenchmarkSummaryRow: FC<{
  summary: BenchmarkScenarioSummary;
  onOpenPipeline: (pipelineId: string) => void;
  onOpenModelCall: (modelCallId: string) => void;
}> = ({ summary, onOpenPipeline, onOpenModelCall }) => (
  <tr className="border-t border-slate-800 text-slate-300">
    <td className="whitespace-nowrap px-3 py-2 font-mono">{summary.variantId}</td>
    <td className="whitespace-nowrap px-3 py-2">{summary.scenarioId}</td>
    <td className="whitespace-nowrap px-3 py-2">{Math.round(summary.successRate * 100)}% ({summary.completed}/{summary.total})</td>
    <td className="whitespace-nowrap px-3 py-2">{formatOptionalDuration(summary.pipelineDuration.avgMs)}</td>
    <td className="whitespace-nowrap px-3 py-2">{formatOptionalDuration(summary.pipelineDuration.p50Ms)}</td>
    <td className="whitespace-nowrap px-3 py-2">{formatOptionalDuration(summary.pipelineDuration.p90Ms)}</td>
    <td className="whitespace-nowrap px-3 py-2">{summary.charsPerSecond !== undefined ? summary.charsPerSecond.toFixed(1) : '-'}</td>
    <td className="whitespace-nowrap px-3 py-2">{summary.coldStarts}</td>
    <td className="whitespace-nowrap px-3 py-2">
      <div className="flex gap-2">
        {summary.samplePipelineIds[0] ? (
          <button
            type="button"
            onClick={() => onOpenPipeline(summary.samplePipelineIds[0]!)}
            className="rounded-md border border-indigo-500/40 px-2 py-1 text-[11px] font-semibold text-indigo-200 transition hover:bg-indigo-500/10"
          >
            Pipeline
          </button>
        ) : null}
        {summary.sampleModelCallIds[0] ? (
          <button
            type="button"
            onClick={() => onOpenModelCall(summary.sampleModelCallIds[0]!)}
            className="rounded-md border border-indigo-500/40 px-2 py-1 text-[11px] font-semibold text-indigo-200 transition hover:bg-indigo-500/10"
          >
            Model
          </button>
        ) : null}
      </div>
    </td>
  </tr>
);

const BenchmarkStagePanel: FC<{ summary: BenchmarkScenarioSummary }> = ({ summary }) => {
  const stages = Object.entries(summary.stageDurations);
  const models = Object.entries(summary.modelDurations);
  if (!stages.length && !models.length) return null;
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/70 p-4">
      <div className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">{summary.variantId} / {summary.scenarioId}</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Stages</div>
          {stages.length ? stages.map(([stage, metric]) => (
            <div key={stage} className="flex justify-between gap-3 text-xs text-slate-300">
              <span>{stage}</span>
              <span>{formatOptionalDuration(metric.avgMs)} avg · {formatOptionalDuration(metric.p90Ms)} p90</span>
            </div>
          )) : <div className="text-xs text-slate-500">-</div>}
        </div>
        <div className="space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Models</div>
          {models.length ? models.map(([scope, metric]) => (
            <div key={scope} className="text-xs text-slate-300">
              <div className="flex justify-between gap-3">
                <span>{scope}</span>
                <span>{formatOptionalDuration(metric.avgMs)} avg</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500">out {metric.outputChars} · {metric.charsPerSecond !== undefined ? `${metric.charsPerSecond.toFixed(1)} chars/s` : '-'}</div>
            </div>
          )) : <div className="text-xs text-slate-500">-</div>}
        </div>
      </div>
    </div>
  );
};

const PipelineDetailView: FC<{
  pipeline: PipelineDetail;
  language: Language;
  availableModelCallIds: Set<string>;
  availableIncidentIds: Set<string>;
  onOpenModelCall: (modelCallId: string, pipelineId: string) => void;
  onOpenIncident: (incidentId: string) => void;
  onDelete: () => void;
}> = ({ pipeline, language, availableModelCallIds, availableIncidentIds, onOpenModelCall, onOpenIncident, onDelete }) => {
  const summaryJson = pipeline.summary ? JSON.stringify(pipeline.summary, null, 2) : '';
  const metadataJson = pipeline.metadata ? JSON.stringify(pipeline.metadata, null, 2) : '';
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${levelClass(pipeline.severity)}`}>{pipeline.severity}</span>
            <span className="rounded-full bg-slate-800 px-2.5 py-1 text-[10px] font-bold uppercase text-slate-300">{pipeline.status}</span>
            <span className="rounded-full bg-slate-800 px-2.5 py-1 text-[10px] font-bold uppercase text-slate-300">{pipeline.kind}</span>
          </div>
          <h3 className="mt-3 text-xl font-bold text-white">{pipeline.title}</h3>
          <div className="mt-2 break-all font-mono text-xs text-slate-500">{pipeline.id}</div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/10"
          >
            {language === 'zh' ? '删除' : 'Delete'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <InfoBlock label="Started" value={formatDate(pipeline.startedAt, language)} />
        <InfoBlock label="Duration" value={pipeline.durationMs !== undefined ? formatDurationMs(pipeline.durationMs) : '-'} />
        <InfoBlock label="Conversation" value={pipeline.conversationId || '-'} />
      </div>

      {pipeline.userCommand ? <TextPanel title={language === 'zh' ? '用户指令' : 'User Command'} text={pipeline.userCommand} /> : null}
      <Timeline
        events={pipeline.events}
        language={language}
        availableModelCallIds={availableModelCallIds}
        availableIncidentIds={availableIncidentIds}
        onOpenModelCall={onOpenModelCall}
        onOpenIncident={onOpenIncident}
      />
      {summaryJson ? <TextPanel title="Summary" text={summaryJson} /> : null}
      {metadataJson ? <TextPanel title="Metadata" text={metadataJson} /> : null}
    </div>
  );
};

const Timeline: FC<{
  events: PipelineEvent[];
  language: Language;
  availableModelCallIds: Set<string>;
  availableIncidentIds: Set<string>;
  onOpenModelCall: (modelCallId: string, pipelineId: string) => void;
  onOpenIncident: (incidentId: string) => void;
}> = ({ events, language, availableModelCallIds, availableIncidentIds, onOpenModelCall, onOpenIncident }) => (
  <div className="rounded-md border border-slate-800 bg-slate-950/70 p-4">
    <div className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-500">Timeline</div>
    <div className="space-y-3">
      {events.length ? events.map(event => {
        const modelRef = getModelCallRef(event);
        const incidentRef = getIncidentRef(event);
        const transcriptText = getTranscriptText(event);
        const canOpenModelCall = modelRef ? availableModelCallIds.has(modelRef.modelCallId) : false;
        const canOpenIncident = incidentRef ? availableIncidentIds.has(incidentRef.incidentId) : false;
        return (
          <div key={event.id} className="grid grid-cols-[84px_minmax(0,1fr)] gap-3">
            <div className="font-mono text-[11px] text-slate-500">{formatDateShort(event.ts, language)}</div>
            <div className="border-l border-slate-800 pl-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${levelClass(event.level)}`}>{event.level}</span>
                <span className="text-xs font-semibold text-slate-200">{stageLabel(event.stage, language)}</span>
                <span className="text-[11px] text-slate-500">{event.eventType}</span>
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-100">{event.title}</div>
              {modelRef ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span>{modelRef.scope || 'model call'}</span>
                  <span>{modelRef.modelId}</span>
                  <span>{modelRef.status}</span>
                  <span>in {modelRef.inputChars ?? 0}</span>
                  <span>out {modelRef.outputChars ?? 0}</span>
                  {canOpenModelCall ? (
                    <button
                      type="button"
                      onClick={() => onOpenModelCall(modelRef.modelCallId, event.pipelineId)}
                      className="rounded-md border border-indigo-500/40 px-2 py-1 text-[11px] font-semibold text-indigo-200 transition hover:bg-indigo-500/10"
                    >
                      {language === 'zh' ? '查看模型调用' : 'Open model call'}
                    </button>
                  ) : null}
                </div>
              ) : incidentRef ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span>{incidentRef.reason || 'incident'}</span>
                  <span>{incidentRef.severity}</span>
                  {canOpenIncident ? (
                    <button
                      type="button"
                      onClick={() => onOpenIncident(incidentRef.incidentId)}
                      className="rounded-md border border-indigo-500/40 px-2 py-1 text-[11px] font-semibold text-indigo-200 transition hover:bg-indigo-500/10"
                    >
                      {language === 'zh' ? '查看异常复盘' : 'Open incident'}
                    </button>
                  ) : null}
                </div>
              ) : event.message || event.detail ? (
                <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-slate-400">{event.message || event.detail}</div>
              ) : null}
              {transcriptText ? (
                <div className="mt-2 whitespace-pre-wrap break-words rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs leading-5 text-slate-200">
                  {transcriptText}
                </div>
              ) : null}
              {event.timings?.length ? (
                <EventTimings eventId={event.id} timings={event.timings} />
              ) : null}
            </div>
          </div>
        );
      }) : <div className="text-sm text-slate-500">No events</div>}
    </div>
  </div>
);

const EventTimings: FC<{ eventId: string; timings: TaskTiming[] }> = ({ eventId, timings }) => {
  const grouped = groupTimingsByDetail(timings);
  if (!grouped) {
    return (
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-emerald-300">
        {timings.map(timing => <span key={`${eventId}-${timing.key}`}>{timing.label}: {formatDurationMs(timing.durationMs)}</span>)}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-1 text-[11px] text-emerald-300">
      {grouped.map(group => (
        <div key={`${eventId}-${group.detail}`} className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="min-w-36 font-semibold text-emerald-200">{group.detail}</span>
          {group.timings.map(timing => (
            <span key={`${eventId}-${group.detail}-${timing.key}`}>{timing.label}: {formatDurationMs(timing.durationMs)}</span>
          ))}
        </div>
      ))}
    </div>
  );
};

const ModelCallDetailView: FC<{
  detail: ModelCallDetail;
  language: Language;
  showPipelineReturn: boolean;
  onOpenPipeline: () => void;
  onOpenIncident: (incidentId: string) => void;
  onDelete: () => void;
}> = ({ detail, language, showPipelineReturn, onOpenPipeline, onOpenIncident, onDelete }) => {
  const { modelCall, pipeline } = detail;
  const metadataJson = modelCall.metadata ? JSON.stringify(modelCall.metadata, null, 2) : '';
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${modelCall.status === 'failed' ? levelClass('error') : levelClass('info')}`}>{modelCall.status}</span>
            <span className="rounded-full bg-slate-800 px-2.5 py-1 text-[10px] font-bold uppercase text-slate-300">{modelCall.stage}</span>
          </div>
          <h3 className="mt-3 text-xl font-bold text-white">{modelCall.scope}</h3>
          <div className="mt-2 break-all font-mono text-xs text-slate-500">{modelCall.id}</div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {showPipelineReturn ? (
            <button
              type="button"
              onClick={onOpenPipeline}
              className="rounded-md border border-indigo-500/40 px-3 py-2 text-xs font-semibold text-indigo-100 transition hover:bg-indigo-500/10"
            >
              {language === 'zh' ? '查看所属 Pipeline' : 'Open Pipeline'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/10"
          >
            {language === 'zh' ? '删除' : 'Delete'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <InfoBlock label="Model" value={modelCall.modelId} />
        <InfoBlock label="Time" value={formatDate(modelCall.ts, language)} />
        <InfoBlock label="Duration" value={modelCall.durationMs !== undefined ? formatDurationMs(modelCall.durationMs) : '-'} />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <InfoBlock label="Input" value={`${modelCall.inputChars ?? 0} chars`} />
        <InfoBlock label="Output" value={`${modelCall.outputChars ?? 0} chars`} />
        <InfoBlock label="Pipeline" value={pipeline?.title ?? modelCall.pipelineId} />
      </div>

      {modelCall.promptPreview ? <TextPanel title="Prompt" text={modelCall.promptPreview} /> : null}
      {modelCall.outputPreview ? <TextPanel title="Output" text={modelCall.outputPreview} /> : null}
      {modelCall.error ? <TextPanel title="Error" text={modelCall.error} /> : null}
      {detail.incidents?.length ? <LinkedIncidentsPanel incidents={detail.incidents} language={language} onOpenIncident={onOpenIncident} /> : null}
      {metadataJson ? <TextPanel title="Metadata" text={metadataJson} /> : null}
    </div>
  );
};

const LinkedIncidentsPanel: FC<{
  incidents: PipelineIncident[];
  language: Language;
  onOpenIncident: (incidentId: string) => void;
}> = ({ incidents, language, onOpenIncident }) => (
  <div className="rounded-md border border-slate-800 bg-slate-950/70 p-4">
    <div className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">Linked Incidents</div>
    <div className="space-y-3">
      {incidents.map(incident => (
        <div
          key={incident.id}
          className="rounded-md border border-slate-800 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-slate-100">{incident.reason}</div>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${levelClass(incident.severity)}`}>{incident.severity}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">{incident.stage} · {formatDate(incident.ts, language)}</div>
          <div className="mt-2 line-clamp-2 text-xs text-slate-400">{incident.recommendedAction || incident.outputSnapshot || '-'}</div>
          <button
            type="button"
            onClick={() => onOpenIncident(incident.id)}
            className="mt-3 rounded-md border border-indigo-500/40 px-2 py-1 text-[11px] font-semibold text-indigo-200 transition hover:bg-indigo-500/10"
          >
            {language === 'zh' ? '查看异常复盘' : 'Open incident'}
          </button>
        </div>
      ))}
    </div>
  </div>
);

const IncidentDetailView: FC<{
  detail: IncidentDetail;
  language: Language;
  onOpenPipeline?: () => void;
  onDelete: () => void;
}> = ({ detail, language, onOpenPipeline, onDelete }) => {
  const { incident, pipeline } = detail;
  const metadataJson = incident.metadata ? JSON.stringify(incident.metadata, null, 2) : '';
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${levelClass(incident.severity)}`}>{incident.severity}</span>
            <span className="rounded-full bg-slate-800 px-2.5 py-1 text-[10px] font-bold uppercase text-slate-300">{incident.stage}</span>
          </div>
          <h3 className="mt-3 text-xl font-bold text-white">{incident.reason}</h3>
          <div className="mt-2 break-all font-mono text-xs text-slate-500">{incident.id}</div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {onOpenPipeline ? (
            <button
              type="button"
              onClick={onOpenPipeline}
              className="rounded-md border border-indigo-500/40 px-3 py-2 text-xs font-semibold text-indigo-100 transition hover:bg-indigo-500/10"
            >
              {language === 'zh' ? '查看所属 Pipeline' : 'Open Pipeline'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/10"
          >
            {language === 'zh' ? '删除' : 'Delete'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <InfoBlock label="Time" value={formatDate(incident.ts, language)} />
        <InfoBlock label="Pipeline" value={pipeline?.title ?? incident.pipelineId} />
        <InfoBlock label="Event" value={incident.eventId ?? '-'} />
      </div>

      {incident.recommendedAction ? <TextPanel title="Recommended Action" text={incident.recommendedAction} /> : null}
      {incident.inputSnapshot ? <TextPanel title="Input Snapshot" text={incident.inputSnapshot} /> : null}
      {incident.outputSnapshot ? <TextPanel title="Output Snapshot" text={incident.outputSnapshot} /> : null}
      {incident.summary ? <TextPanel title="Summary" text={incident.summary} /> : null}
      {metadataJson ? <TextPanel title="Metadata" text={metadataJson} /> : null}
    </div>
  );
};

const InfoBlock: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-md border border-slate-800 bg-slate-950/70 p-3">
    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
    <div className="mt-2 break-words text-sm text-slate-200">{value}</div>
  </div>
);

const TextPanel: FC<{ title: string; text: string; compact?: boolean }> = ({ title, text, compact }) => (
  <div className={`${compact ? 'mt-3' : ''} rounded-md border border-slate-800 bg-slate-950/70 p-4`}>
    <div className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">{title}</div>
    <pre className={`${compact ? 'max-h-48' : 'max-h-96'} overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-300`}>{text}</pre>
  </div>
);

function tabLabel(tab: LogsTab, language: Language): string {
  const zh: Record<LogsTab, string> = { pipelines: 'Pipeline', model: '模型调用', incidents: '异常复盘', benchmarks: 'Benchmark' };
  const en: Record<LogsTab, string> = { pipelines: 'Pipelines', model: 'Model Calls', incidents: 'Incidents', benchmarks: 'Benchmarks' };
  return language === 'zh' ? zh[tab] : en[tab];
}

function tabCount(tab: LogsTab, pipelines: PipelineRun[], modelCalls: ModelCallRecord[], incidents: PipelineIncident[], benchmarkRuns: BenchmarkRunListItem[]): number {
  if (tab === 'benchmarks') return benchmarkRuns.length;
  if (tab === 'model') return modelCalls.length;
  if (tab === 'incidents') return incidents.length;
  return pipelines.length;
}

function visibleCount(tab: LogsTab, pipelines: PipelineRun[], modelCalls: ModelCallRecord[], incidents: PipelineIncident[], benchmarkRuns: BenchmarkRunListItem[]): number {
  if (tab === 'benchmarks') return benchmarkRuns.length;
  if (tab === 'model') return modelCalls.length;
  if (tab === 'incidents') return incidents.length;
  return pipelines.length;
}

function getModelCallRef(event: PipelineEvent): ModelCallRef | null {
  if (event.eventType !== 'model_call') return null;
  const metadata = getRecord(event.metadata);
  const modelCallId = stringValue(metadata.modelCallId);
  if (!modelCallId) return null;
  return {
    modelCallId,
    scope: stringValue(metadata.scope),
    modelId: stringValue(metadata.modelId),
    status: stringValue(metadata.status),
    inputChars: numberValue(metadata.inputChars),
    outputChars: numberValue(metadata.outputChars),
  };
}

function getIncidentRef(event: PipelineEvent): IncidentRef | null {
  if (event.eventType !== 'repair' && event.eventType !== 'fallback') return null;
  const metadata = getRecord(event.metadata);
  const incidentId = stringValue(metadata.incidentId);
  if (!incidentId) return null;
  const severity = metadata.severity === 'error' || metadata.severity === 'warn' ? metadata.severity : undefined;
  return {
    incidentId,
    severity,
    reason: event.title,
  };
}

function getTranscriptText(event: PipelineEvent): string | null {
  if (event.stage !== 'asr' && event.stage !== 'wake') return null;
  const metadata = getRecord(event.metadata);
  return stringValue(metadata.text)
    ?? stringValue(metadata.transcript)
    ?? stringValue(metadata.command)
    ?? stringValue(metadata.rawTranscript)
    ?? null;
}

function groupTimingsByDetail(timings: TaskTiming[]): Array<{ detail: string; timings: TaskTiming[] }> | null {
  if (!timings.some(timing => timing.detail)) return null;
  const groups: Array<{ detail: string; timings: TaskTiming[] }> = [];
  const indexByDetail = new Map<string, number>();
  for (const timing of timings) {
    const detail = timing.detail;
    if (!detail) return null;
    const existingIndex = indexByDetail.get(detail);
    if (existingIndex === undefined) {
      indexByDetail.set(detail, groups.length);
      groups.push({ detail, timings: [timing] });
      continue;
    }
    groups[existingIndex]?.timings.push(timing);
  }
  return groups;
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function domId(prefix: string, value: string): string {
  return `${prefix}-${encodeURIComponent(value)}`;
}

function levelClass(level: PipelineLevel): string {
  if (level === 'error') return 'bg-rose-500/15 text-rose-300';
  if (level === 'warn') return 'bg-amber-500/15 text-amber-300';
  if (level === 'debug') return 'bg-slate-500/15 text-slate-300';
  return 'bg-sky-500/15 text-sky-300';
}

function kindLabel(kind: PipelineKind, language: Language): string {
  const zh: Record<PipelineKind, string> = {
    system: '系统',
    conversation: '对话',
  };
  const en: Record<PipelineKind, string> = {
    system: 'System',
    conversation: 'Conversation',
  };
  return language === 'zh' ? zh[kind] : en[kind];
}

function stageLabel(stage: PipelineStage, language: Language): string {
  const zh: Record<PipelineStage, string> = {
    wake: '唤醒',
    asr: 'ASR',
    intent: '意图',
    context: '上下文',
    memory: '记忆',
    vision: '视觉',
    model: '模型',
    tool: '工具',
    tts: 'TTS',
    service: '服务',
    summary: '总结',
  };
  return language === 'zh' ? zh[stage] : stage;
}

function formatDate(value: number, language: Language): string {
  return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US');
}

function formatDateShort(value: number, language: Language): string {
  return new Date(value).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDurationMs(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function formatOptionalDuration(value: number | undefined): string {
  return value === undefined ? '-' : formatDurationMs(value);
}
