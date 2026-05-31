import { type FC, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';

type ConversationRecord = {
  conversationId: string;
  messages: Array<{
    role: 'user' | 'agent';
    content: string;
    createdAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

type ConversationResponse = {
  conversations: ConversationRecord[];
  total: number;
  limit: number;
  offset: number;
};

type PrunedMemoryRecord = {
  id: string;
  sourceConversationId: string;
  content: string;
  baseScore: number;
  hitCount: number;
  createdAt: number;
  lastAccessedAt: number;
  status: 'warm' | 'cold';
  topic: string;
  userState: string;
  behaviorSignal: string;
  interactionResult: string;
  location: 'living_room' | 'bedroom' | 'kitchen' | 'unknown';
  timeBucket: 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';
  dayType: 'weekday' | 'weekend';
};

type MemoryCandidateRecord = {
  id: string;
  sourceConversationId: string;
  draftJson: string;
  score: number;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  reviewedAt: number | null;
};

const PAGE_SIZE = 20;

export const MemoryView: FC = () => {
  const { language, t } = useI18n();
  const [activeMemoryTab, setActiveMemoryTab] = useState<'raw' | 'brief' | 'candidates'>('raw');
  const [query, setQuery] = useState('');
  const [briefQuery, setBriefQuery] = useState('');
  const [candidateQuery, setCandidateQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [briefRefreshKey, setBriefRefreshKey] = useState(0);
  const [candidateRefreshKey, setCandidateRefreshKey] = useState(0);
  const [data, setData] = useState<ConversationResponse>({ conversations: [], total: 0, limit: PAGE_SIZE, offset: 0 });
  const [briefMemories, setBriefMemories] = useState<PrunedMemoryRecord[]>([]);
  const [memoryCandidates, setMemoryCandidates] = useState<MemoryCandidateRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [briefLoading, setBriefLoading] = useState(false);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedConversation, setSelectedConversation] = useState<ConversationRecord | null>(null);
  const [pruneContent, setPruneContent] = useState('');
  const [pruneInstruction, setPruneInstruction] = useState('');
  const [pruneStatus, setPruneStatus] = useState('');
  const [pruning, setPruning] = useState(false);
  const [savingPrunedMemory, setSavingPrunedMemory] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState('');
  const [candidateStatus, setCandidateStatus] = useState('');

  const params = useMemo(() => {
    const nextParams = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });

    if (query.trim()) nextParams.set('query', query.trim());
    if (from) nextParams.set('from', toIsoString(from));
    if (to) nextParams.set('to', toIsoString(to));

    return nextParams;
  }, [from, offset, query, to]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadConversations() {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(`/api/conversations?${params.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        setData(await response.json() as ConversationResponse);
      } catch (fetchError) {
        if (!controller.signal.aborted) {
          setError(fetchError instanceof Error ? fetchError.message : t('memory.error'));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadConversations();
    return () => controller.abort();
  }, [params, refreshKey, t]);

  const briefParams = useMemo(() => {
    const nextParams = new URLSearchParams({ limit: '100' });
    if (briefQuery.trim()) nextParams.set('query', briefQuery.trim());
    return nextParams;
  }, [briefQuery]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadBriefMemories() {
      setBriefLoading(true);
      setMemoryStatus('');
      try {
        const response = await fetch(`/api/memories?${briefParams.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json() as { memories: PrunedMemoryRecord[] };
        setBriefMemories(data.memories);
      } catch (fetchError) {
        if (!controller.signal.aborted) {
          setMemoryStatus(fetchError instanceof Error ? fetchError.message : t('memory.error'));
        }
      } finally {
        if (!controller.signal.aborted) {
          setBriefLoading(false);
        }
      }
    }

    void loadBriefMemories();
    return () => controller.abort();
  }, [briefParams, briefRefreshKey, t]);

  const candidateParams = useMemo(() => {
    const nextParams = new URLSearchParams({ limit: '100', status: 'pending' });
    if (candidateQuery.trim()) nextParams.set('query', candidateQuery.trim());
    return nextParams;
  }, [candidateQuery]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadMemoryCandidates() {
      setCandidateLoading(true);
      setCandidateStatus('');
      try {
        const response = await fetch(`/api/memory-candidates?${candidateParams.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json() as { candidates: MemoryCandidateRecord[] };
        setMemoryCandidates(data.candidates);
      } catch (fetchError) {
        if (!controller.signal.aborted) {
          setCandidateStatus(fetchError instanceof Error ? fetchError.message : t('memory.error'));
        }
      } finally {
        if (!controller.signal.aborted) {
          setCandidateLoading(false);
        }
      }
    }

    void loadMemoryCandidates();
    return () => controller.abort();
  }, [candidateParams, candidateRefreshKey, t]);

  const pageStart = data.total === 0 ? 0 : data.offset + 1;
  const pageEnd = Math.min(data.offset + data.conversations.length, data.total);
  const hasPrevious = offset > 0;
  const hasNext = offset + PAGE_SIZE < data.total;

  async function removeConversation(conversationId: string) {
    if (!window.confirm(t('memory.removeConfirm'))) return;

    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      setError(`HTTP ${response.status}`);
      return;
    }

    setRefreshKey((value) => value + 1);
    if (selectedConversation?.conversationId === conversationId) {
      setSelectedConversation(null);
    }
  }

  function openDetails(conversation: ConversationRecord) {
    setSelectedConversation(conversation);
    setPruneContent('');
    setPruneInstruction('');
    setPruneStatus('');
    setPruning(false);
    setSavingPrunedMemory(false);
    setMemoryStatus('');
  }

  async function generatePrunedDraft() {
    if (!selectedConversation) return;

    setPruning(true);
    setPruneStatus(t('memory.pruning'));
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(selectedConversation.conversationId)}/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: pruneInstruction }),
      });

      if (!response.ok) {
        setPruneStatus(`${t('memory.error')}: HTTP ${response.status}`);
        return;
      }

      const data = await response.json() as { draft?: string };
      setPruneContent(data.draft ?? '');
      setPruneStatus(t('memory.pruneReady'));
    } finally {
      setPruning(false);
    }
  }

  async function savePrunedMemory() {
    if (!selectedConversation || savingPrunedMemory) return;

    setSavingPrunedMemory(true);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(selectedConversation.conversationId)}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: pruneContent }),
      });

      if (!response.ok) {
        setPruneStatus(`${t('memory.error')}: HTTP ${response.status}`);
        return;
      }

      setPruneStatus(t('memory.pruneSaved'));
      setBriefRefreshKey((value) => value + 1);
    } finally {
      setSavingPrunedMemory(false);
    }
  }

  async function updatePrunedMemory(memoryId: string, content: string) {
    const response = await fetch(`/api/memories/${encodeURIComponent(memoryId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      setMemoryStatus(`${t('memory.error')}: HTTP ${response.status}`);
      return;
    }

    setMemoryStatus(t('memory.updated'));
    setBriefRefreshKey((value) => value + 1);
  }

  async function removePrunedMemory(memoryId: string) {
    if (!window.confirm(t('memory.removeMemoryConfirm'))) return;

    const response = await fetch(`/api/memories/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      setMemoryStatus(`${t('memory.error')}: HTTP ${response.status}`);
      return;
    }

    setBriefMemories((value) => value.filter((item) => item.id !== memoryId));
  }

  async function approveMemoryCandidate(candidateId: string, content: string) {
    const response = await fetch(`/api/memory-candidates/${encodeURIComponent(candidateId)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      setCandidateStatus(`${t('memory.error')}: HTTP ${response.status}`);
      return;
    }

    setCandidateStatus(t('memory.candidateApproved'));
    setMemoryCandidates((value) => value.filter((item) => item.id !== candidateId));
    setBriefRefreshKey((value) => value + 1);
  }

  async function rejectMemoryCandidate(candidateId: string) {
    const response = await fetch(`/api/memory-candidates/${encodeURIComponent(candidateId)}/reject`, {
      method: 'POST',
    });

    if (!response.ok) {
      setCandidateStatus(`${t('memory.error')}: HTTP ${response.status}`);
      return;
    }

    setCandidateStatus(t('memory.candidateRejected'));
    setMemoryCandidates((value) => value.filter((item) => item.id !== candidateId));
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex gap-2 border-b border-slate-800">
        {(['raw', 'brief', 'candidates'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveMemoryTab(tab)}
            className={`rounded-t-lg border border-b-0 px-4 py-2 text-sm font-medium transition ${
              activeMemoryTab === tab
                ? 'border-slate-700 bg-slate-900 text-white'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {tab === 'raw'
              ? t('memory.rawSessions')
              : tab === 'brief'
                ? t('memory.briefMemories')
                : t('memory.pendingCandidates')}
          </button>
        ))}
      </div>

      {activeMemoryTab === 'raw' ? (
      <>
      <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5 space-y-4">
        <div className="grid grid-cols-1 items-end gap-3 lg:grid-cols-[minmax(260px,1fr)_190px_190px_auto_auto]">
          <label className="flex flex-col gap-1">
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
              placeholder={t('memory.searchPlaceholder')}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-indigo-500"
            />
          </label>
          <label className="flex flex-col gap-1">
            <input
              type="datetime-local"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setOffset(0);
              }}
              placeholder={t('memory.from')}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-indigo-500"
            />
          </label>
          <label className="flex flex-col gap-1">
            <input
              type="datetime-local"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setOffset(0);
              }}
              placeholder={t('memory.to')}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-indigo-500"
            />
          </label>
          <button
            type="button"
            onClick={() => setRefreshKey((value) => value + 1)}
            className="h-10 rounded-lg border border-indigo-500/40 bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-500"
          >
            {t('memory.refresh')}
          </button>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setFrom('');
              setTo('');
              setOffset(0);
            }}
            className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-4 text-sm font-medium text-slate-300 transition hover:bg-slate-800"
          >
            {t('memory.clear')}
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{loading ? t('memory.loading') : `${pageStart}-${pageEnd} / ${data.total} ${t('memory.results')}`}</span>
          {error && <span className="text-rose-400">{t('memory.error')}: {error}</span>}
        </div>
      </div>

      {data.conversations.length === 0 && !loading ? (
        <div className="flex h-48 items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/50 text-sm text-slate-500">
          {t('memory.empty')}
        </div>
      ) : (
        <div className="space-y-3">
          {data.conversations.map((conversation) => (
            <article key={conversation.conversationId} className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="font-mono text-[11px] text-slate-500">{conversation.conversationId}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-xs text-slate-500">
                    {t('memory.createdAt')}: {formatDate(conversation.createdAt, language)}
                  </div>
                  <button
                    type="button"
                    onClick={() => openDetails(conversation)}
                    className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-slate-800"
                  >
                    {t('memory.details')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeConversation(conversation.conversationId)}
                    className="rounded-md border border-rose-500/30 px-2.5 py-1 text-xs text-rose-300 transition hover:bg-rose-500/10"
                  >
                    {t('memory.remove')}
                  </button>
                </div>
              </div>
              <div className="space-y-4">
                {conversation.messages.map((message, index) => (
                  <section key={`${message.createdAt}-${index}`} className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                    <div className={`text-[10px] font-bold uppercase tracking-widest ${message.role === 'user' ? 'text-indigo-300' : 'text-emerald-300'}`}>
                      {message.role === 'user' ? t('memory.user') : t('memory.agent')}
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">{message.content}</p>
                  </section>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-3">
        <button
          type="button"
          disabled={!hasPrevious}
          onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
          className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('memory.previous')}
        </button>
        <button
          type="button"
          disabled={!hasNext}
          onClick={() => setOffset((value) => value + PAGE_SIZE)}
          className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('memory.next')}
        </button>
      </div>
      </>
      ) : activeMemoryTab === 'brief' ? (
      <>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="grid grid-cols-1 items-end gap-3 lg:grid-cols-[1fr_auto]">
            <input
              type="search"
              value={briefQuery}
              onChange={(event) => setBriefQuery(event.target.value)}
              placeholder={t('memory.briefSearchPlaceholder')}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-indigo-500"
            />
            <button
              type="button"
              onClick={() => setBriefRefreshKey((value) => value + 1)}
              className="h-10 rounded-lg border border-indigo-500/40 bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-500"
            >
              {t('memory.refresh')}
            </button>
          </div>
          <div className="mt-3 text-xs text-slate-500">{briefLoading ? t('memory.loading') : `${briefMemories.length} ${t('memory.briefMemories')}`}</div>
          {memoryStatus && <div className="mt-2 text-xs text-emerald-400">{memoryStatus}</div>}
        </div>

        {briefMemories.length === 0 && !briefLoading ? (
          <div className="flex h-48 items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/50 text-sm text-slate-500">
            {t('memory.noPruned')}
          </div>
        ) : (
          <div className="space-y-3">
            {briefMemories.map((item) => (
              <PrunedMemoryEditor
                key={item.id}
                item={item}
                t={t}
                language={language}
                onUpdate={(content) => void updatePrunedMemory(item.id, content)}
                onRemove={() => void removePrunedMemory(item.id)}
              />
            ))}
          </div>
        )}
      </>
      ) : (
      <>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="grid grid-cols-1 items-end gap-3 lg:grid-cols-[1fr_auto]">
            <input
              type="search"
              value={candidateQuery}
              onChange={(event) => setCandidateQuery(event.target.value)}
              placeholder={t('memory.candidateSearchPlaceholder')}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-indigo-500"
            />
            <button
              type="button"
              onClick={() => setCandidateRefreshKey((value) => value + 1)}
              className="h-10 rounded-lg border border-indigo-500/40 bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-500"
            >
              {t('memory.refresh')}
            </button>
          </div>
          <div className="mt-3 text-xs text-slate-500">{candidateLoading ? t('memory.loading') : `${memoryCandidates.length} ${t('memory.pendingCandidates')}`}</div>
          {candidateStatus && <div className="mt-2 text-xs text-emerald-400">{candidateStatus}</div>}
        </div>

        {memoryCandidates.length === 0 && !candidateLoading ? (
          <div className="flex h-48 items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/50 text-sm text-slate-500">
            {t('memory.noCandidates')}
          </div>
        ) : (
          <div className="space-y-3">
            {memoryCandidates.map((item) => (
              <MemoryCandidateEditor
                key={item.id}
                item={item}
                t={t}
                language={language}
                onApprove={(content) => void approveMemoryCandidate(item.id, content)}
                onReject={() => void rejectMemoryCandidate(item.id)}
              />
            ))}
          </div>
        )}
      </>
      )}

      {selectedConversation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
            <div className="sticky top-0 flex items-center justify-between border-b border-slate-800 bg-slate-950 px-6 py-4">
              <div>
                <h3 className="text-lg font-semibold text-white">{t('memory.pruneTitle')}</h3>
                <p className="font-mono text-[11px] text-slate-500">{selectedConversation.conversationId}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedConversation(null)}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
              >
                {t('memory.close')}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_1fr]">
                <div className="space-y-4">
                  {selectedConversation.messages.map((message, index) => (
                    <section key={`${message.createdAt}-${index}`} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                      <div className={`mb-2 text-[10px] font-bold uppercase tracking-widest ${message.role === 'user' ? 'text-indigo-300' : 'text-emerald-300'}`}>
                        {message.role === 'user' ? t('memory.user') : t('memory.agent')}
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">{message.content}</p>
                    </section>
                  ))}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500">{t('memory.pruneHint')}</label>
                    <button
                      type="button"
                      onClick={() => void generatePrunedDraft()}
                      disabled={pruning}
                      className="rounded-lg border border-indigo-500/40 bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {pruneContent ? t('memory.reprune') : t('memory.prune')}
                    </button>
                  </div>
                  <textarea
                    value={pruneInstruction}
                    onChange={(event) => setPruneInstruction(event.target.value)}
                    placeholder={t('memory.pruneInstructionPlaceholder')}
                    className="min-h-24 w-full resize-y rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-indigo-500"
                  />
                  <textarea
                    value={pruneContent}
                    onChange={(event) => setPruneContent(event.target.value)}
                    className="min-h-[320px] w-full resize-y rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm leading-6 text-slate-100 outline-none transition focus:border-indigo-500"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <span className={`text-xs ${pruneStatus.startsWith(t('memory.error')) ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {pruneStatus}
                    </span>
                    <button
                      type="button"
                      onClick={() => void savePrunedMemory()}
                      disabled={!pruneContent.trim() || savingPrunedMemory}
                      className="rounded-lg border border-emerald-500/40 bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {savingPrunedMemory ? t('memory.saving') : t('memory.saveApproved')}
                    </button>
                  </div>
                </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function toIsoString(value: string): string {
  return new Date(value).toISOString();
}

function formatDate(value: string, language: 'zh' | 'en'): string {
  return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US');
}

const PrunedMemoryEditor: FC<{
  item: PrunedMemoryRecord;
  t: ReturnType<typeof useI18n>['t'];
  language: 'zh' | 'en';
  onUpdate: (content: string) => void;
  onRemove: () => void;
}> = ({ item, t, language, onUpdate, onRemove }) => {
  const [content, setContent] = useState(item.content);

  useEffect(() => {
    setContent(item.content);
  }, [item.content]);

  return (
    <section className="mx-6 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="font-mono text-[11px] text-slate-500">{item.id}</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onUpdate(content)}
            disabled={!content.trim()}
            className="rounded-md border border-emerald-500/40 px-3 py-1 text-xs text-emerald-300 transition hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('memory.update')}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md border border-rose-500/30 px-3 py-1 text-xs text-rose-300 transition hover:bg-rose-500/10"
          >
            {t('memory.remove')}
          </button>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-1 gap-2 text-xs text-slate-400 md:grid-cols-2">
        <MemoryMeta label={t('memory.topic')} value={item.topic || '-'} />
        <MemoryMeta label={t('memory.score')} value={`${item.baseScore} / 5 · ${item.status}`} />
        <MemoryMeta label={t('memory.userState')} value={item.userState || '-'} />
        <MemoryMeta label={t('memory.behaviorSignal')} value={item.behaviorSignal || '-'} />
        <MemoryMeta label={t('memory.interactionResult')} value={item.interactionResult || '-'} />
        <MemoryMeta label={t('memory.situation')} value={`${item.location} · ${item.timeBucket} · ${item.dayType}`} />
        <MemoryMeta label={t('memory.hitCount')} value={String(item.hitCount)} />
        <MemoryMeta label={t('memory.lastAccessed')} value={formatEpochDate(item.lastAccessedAt, language)} />
      </div>
      <div className="mb-3 text-xs text-slate-500">
        {t('memory.sourceConversation')}: <span className="font-mono">{item.sourceConversationId}</span>
      </div>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        className="min-h-32 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm leading-6 text-slate-100 outline-none transition focus:border-indigo-500"
      />
    </section>
  );
};

const MemoryCandidateEditor: FC<{
  item: MemoryCandidateRecord;
  t: ReturnType<typeof useI18n>['t'];
  language: 'zh' | 'en';
  onApprove: (content: string) => void;
  onReject: () => void;
}> = ({ item, t, language, onApprove, onReject }) => {
  const [content, setContent] = useState(item.draftJson);

  useEffect(() => {
    setContent(item.draftJson);
  }, [item.draftJson]);

  return (
    <section className="mx-6 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[11px] text-slate-500">{item.id}</div>
          <div className="mt-1 text-xs text-slate-500">
            {t('memory.sourceConversation')}: <span className="font-mono">{item.sourceConversationId}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onApprove(content)}
            disabled={!content.trim()}
            className="rounded-md border border-emerald-500/40 px-3 py-1 text-xs text-emerald-300 transition hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('memory.approve')}
          </button>
          <button
            type="button"
            onClick={onReject}
            className="rounded-md border border-rose-500/30 px-3 py-1 text-xs text-rose-300 transition hover:bg-rose-500/10"
          >
            {t('memory.reject')}
          </button>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-1 gap-2 text-xs text-slate-400 md:grid-cols-3">
        <MemoryMeta label={t('memory.score')} value={`${item.score} / 5 · ${item.status}`} />
        <MemoryMeta label={t('memory.createdAt')} value={formatEpochDate(item.createdAt, language)} />
        <MemoryMeta label={t('memory.reviewedAt')} value={item.reviewedAt ? formatEpochDate(item.reviewedAt, language) : '-'} />
      </div>
      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        className="min-h-48 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm leading-6 text-slate-100 outline-none transition focus:border-indigo-500"
      />
    </section>
  );
};

const MemoryMeta: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
    <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-600">{label}</div>
    <div className="break-words leading-5 text-slate-300">{value}</div>
  </div>
);

function formatEpochDate(value: number, language: 'zh' | 'en'): string {
  return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US');
}
