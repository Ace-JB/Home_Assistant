import { type FC, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';

type ModelRecallLog = {
  id: string;
  stage: 'intention' | 'response' | 'vision' | 'memory_prune';
  reason: string;
  severity: 'info' | 'warn' | 'error';
  userCommand: string;
  promptSnapshot: string;
  state: unknown;
  summary: string | null;
  createdAt: number;
};

const PAGE_SIZE = 100;

export const ModelRecallLogsView: FC = () => {
  const { t, language } = useI18n();
  const [logs, setLogs] = useState<ModelRecallLog[]>([]);
  const [selectedLog, setSelectedLog] = useState<ModelRecallLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void loadLogs();
  }, []);

  const stateJson = useMemo(() => selectedLog ? JSON.stringify(selectedLog.state, null, 2) : '', [selectedLog]);

  async function loadLogs() {
    setLoading(true);
    try {
      const response = await fetch(`/api/model-recall-logs?limit=${PAGE_SIZE}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { logs: ModelRecallLog[] };
      setLogs(data.logs);
      setSelectedLog((current) => current ? data.logs.find(item => item.id === current.id) ?? null : data.logs[0] ?? null);
      setError('');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('logs.error'));
    } finally {
      setLoading(false);
    }
  }

  async function removeLog(logId: string) {
    if (!window.confirm(t('logs.removeConfirm'))) return;
    const response = await fetch(`/api/model-recall-logs/${encodeURIComponent(logId)}`, { method: 'DELETE' });
    if (!response.ok) {
      setError(`${t('logs.error')}: HTTP ${response.status}`);
      return;
    }
    setLogs((value) => value.filter(item => item.id !== logId));
    setSelectedLog((value) => value?.id === logId ? null : value);
  }

  async function summarizeLog(logId: string) {
    setBusy(logId);
    try {
      const response = await fetch(`/api/model-recall-logs/${encodeURIComponent(logId)}/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language }),
      });
      const data = await response.json().catch(() => ({})) as { log?: ModelRecallLog; error?: string };
      if (!response.ok || !data.log) throw new Error(data.error || `HTTP ${response.status}`);
      setSelectedLog(data.log);
      setLogs((value) => value.map(item => item.id === data.log!.id ? data.log! : item));
      setError('');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('logs.error'));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-1 gap-5 animate-in fade-in duration-500 xl:grid-cols-[380px_minmax(0,1fr)]">
      <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-widest text-slate-500">{t('logs.overview')}</div>
            <h3 className="mt-1 text-lg font-bold text-white">{t('logs.title')}</h3>
          </div>
          <button
            type="button"
            onClick={() => void loadLogs()}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            {t('logs.refresh')}
          </button>
        </div>
        <div className="mt-3 text-xs text-slate-500">{loading ? t('logs.loading') : `${logs.length} ${t('logs.items')}`}</div>
        {error ? <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">{error}</div> : null}

        <div className="mt-4 space-y-2">
          {!loading && logs.length === 0 ? (
            <div className="rounded-md border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-500">{t('logs.empty')}</div>
          ) : null}
          {logs.map((log) => (
            <button
              key={log.id}
              type="button"
              onClick={() => setSelectedLog(log)}
              className={`w-full rounded-md border p-3 text-left transition ${
                selectedLog?.id === log.id
                  ? 'border-indigo-500/60 bg-indigo-500/10'
                  : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${severityClass(log.severity)}`}>{log.severity}</span>
                <span className="font-mono text-[11px] text-slate-500">{formatDate(log.createdAt, language)}</span>
              </div>
              <div className="mt-2 text-sm font-semibold text-slate-100">{log.reason}</div>
              <div className="mt-1 text-xs text-slate-500">{log.stage}</div>
              <div className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{log.userCommand || '-'}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-900/80 p-5">
        {!selectedLog ? (
          <div className="flex min-h-[520px] items-center justify-center text-sm text-slate-500">{t('logs.selectHint')}</div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${severityClass(selectedLog.severity)}`}>{selectedLog.severity}</span>
                  <span className="rounded-full bg-slate-800 px-2.5 py-1 text-[10px] font-bold uppercase text-slate-300">{selectedLog.stage}</span>
                </div>
                <h3 className="mt-3 text-xl font-bold text-white">{selectedLog.reason}</h3>
                <div className="mt-2 font-mono text-xs text-slate-500">{selectedLog.id}</div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy === selectedLog.id}
                  onClick={() => void summarizeLog(selectedLog.id)}
                  className="rounded-md bg-indigo-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === selectedLog.id ? t('logs.summarizing') : t('logs.summarize')}
                </button>
                <button
                  type="button"
                  onClick={() => void removeLog(selectedLog.id)}
                  className="rounded-md border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/10"
                >
                  {t('logs.delete')}
                </button>
              </div>
            </div>

            <InfoBlock label={t('logs.createdAt')} value={formatDate(selectedLog.createdAt, language)} />
            <InfoBlock label={t('logs.userCommand')} value={selectedLog.userCommand || '-'} />
            <TextPanel title={t('logs.summary')} text={selectedLog.summary || t('logs.noSummary')} />
            <TextPanel title={t('logs.promptSnapshot')} text={selectedLog.promptSnapshot || '-'} />
            <TextPanel title={t('logs.state')} text={stateJson || '-'} />
          </div>
        )}
      </section>
    </div>
  );
};

const InfoBlock: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-md border border-slate-800 bg-slate-950/70 p-3">
    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
    <div className="mt-2 text-sm text-slate-200">{value}</div>
  </div>
);

const TextPanel: FC<{ title: string; text: string }> = ({ title, text }) => (
  <div className="rounded-md border border-slate-800 bg-slate-950/70 p-4">
    <div className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">{title}</div>
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-300">{text}</pre>
  </div>
);

function severityClass(severity: ModelRecallLog['severity']): string {
  if (severity === 'error') return 'bg-rose-500/15 text-rose-300';
  if (severity === 'warn') return 'bg-amber-500/15 text-amber-300';
  return 'bg-sky-500/15 text-sky-300';
}

function formatDate(value: number, language: 'zh' | 'en'): string {
  return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US');
}
