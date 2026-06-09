import { type ChangeEvent, type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { TranslationKey } from '../i18n';

type VoiceProvider = 'cosyvoice' | 'say';

type VoiceConfig = {
  provider: VoiceProvider;
  baseUrl: string;
  endpoint: string;
  speakerId: string;
  speakerName: string;
  promptAudioPath: string;
  promptText: string;
  timeoutMs: number;
  fallbackToSay: boolean;
};

type ExtractResponse = {
  audioUrl: string;
  audioPath: string;
  transcript: string;
  fileName: string;
  candidates?: MaterialCandidate[];
  videoUrl?: string;
  videoPath?: string;
  timings?: TaskTiming[];
};

type TaskTiming = {
  key: string;
  label: string;
  durationMs: number;
  detail?: string;
};

type MaterialJobStageStatus = 'pending' | 'running' | 'done' | 'failed';

type MaterialJobStage = {
  key: string;
  percent: number;
  status: MaterialJobStageStatus;
  detail?: string;
  durationMs?: number;
  startedAt?: string;
  elapsedMs?: number;
};

type MaterialJobSnapshot<T = unknown> = {
  id: string;
  type: 'probe-url' | 'import-url' | 'extract' | 'save';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  percent: number;
  stageKey: string;
  stages: MaterialJobStage[];
  timings: TaskTiming[];
  result?: T;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type MaterialCandidate = {
  id: string;
  speaker: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  text: string;
  quality: 'high' | 'medium';
  reasons: string[];
  score: number;
  audioPath: string;
  audioUrl: string;
  source: 'raw' | 'vocal';
};

type AudioResource = {
  formatId: string;
  label: string;
  ext: string;
  resolution: string;
  fps: number | null;
  vcodec: string;
  acodec: string;
  filesize: number | null;
  protocol: string;
  previewUrl: string;
};

type YtDlpStatus = {
  installed: boolean;
  bin: string;
  version: string | null;
  error: string | null;
};

type CosyVoiceServiceStatus = {
  ok: boolean;
  url: string;
  status: number | null;
  error: string | null;
};

type SpeakerProfile = {
  id: string;
  name: string;
  promptAudioPath: string;
  promptText: string;
  createdAt: string;
  updatedAt: string;
};

const defaultConfig: VoiceConfig = {
  provider: 'cosyvoice',
  baseUrl: 'http://localhost:10102',
  endpoint: '/inference_zero_shot',
  speakerId: '',
  speakerName: '默认音色',
  promptAudioPath: '',
  promptText: '',
  timeoutMs: 30000,
  fallbackToSay: false,
};

export const VoiceControlView: FC = () => {
  const { t } = useI18n();
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [audioPath, setAudioPath] = useState('');
  const [transcript, setTranscript] = useState('');
  const [candidates, setCandidates] = useState<MaterialCandidate[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [enhanceVocals, setEnhanceVocals] = useState(false);
  const [config, setConfig] = useState<VoiceConfig>(defaultConfig);
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([]);
  const [applyingSpeakerId, setApplyingSpeakerId] = useState('');
  const [deletingSpeakerId, setDeletingSpeakerId] = useState('');
  const [timings, setTimings] = useState<TaskTiming[]>([]);
  const [activeJob, setActiveJob] = useState<MaterialJobSnapshot | null>(null);
  const [jobDialogOpen, setJobDialogOpen] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [resourceUrl, setResourceUrl] = useState('');
  const [resources, setResources] = useState<AudioResource[]>([]);
  const [selectedFormatId, setSelectedFormatId] = useState('');
  const [resourceStatus, setResourceStatus] = useState('');
  const [resourceImportDone, setResourceImportDone] = useState(false);
  const [probing, setProbing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [ytDlpStatus, setYtDlpStatus] = useState<YtDlpStatus | null>(null);
  const [installingYtDlp, setInstallingYtDlp] = useState(false);
  const [checkingCosyVoice, setCheckingCosyVoice] = useState(false);
  const activeJobIdRef = useRef('');
  const jobRunning = extracting || saving || probing || importing;
  const canExtract = !!videoFile && !jobRunning;
  const canSave = !!audioPath && !!transcript.trim() && !jobRunning;
  const resourceJobActive = activeJob?.type === 'probe-url' || activeJob?.type === 'import-url';
  const resourceProgressVisible = probing
    || importing
    || resourceImportDone
    || Boolean(resourceJobActive && activeJob?.status === 'failed');

  useEffect(() => {
    const controller = new AbortController();

    async function loadConfig() {
      try {
        const response = await fetch('/api/voice/cosyvoice/config', { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json() as { config?: VoiceConfig; speakers?: SpeakerProfile[] };
        if (data.config) {
          setConfig({ ...defaultConfig, ...data.config });
          setAudioPath(data.config.promptAudioPath || '');
          setTranscript(data.config.promptText || '');
        }
        setSpeakers(data.speakers ?? []);
      } catch {
        // Non-blocking: defaults are usable until the user saves.
      }
    }

    void loadConfig();
    void refreshYtDlpStatus();
    return () => {
      activeJobIdRef.current = '';
      controller.abort();
    };
  }, []);

  const displayAudioUrl = useMemo(() => {
    if (audioUrl) return audioUrl;
    if (!audioPath) return '';
    return getCosyVoiceAudioUrl(audioPath);
  }, [audioPath, audioUrl]);

  function handleVideoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setVideoFile(file);
    setStatus('');
    setCandidates([]);
    setSelectedCandidateId('');
    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
    }
    setVideoUrl(file ? URL.createObjectURL(file) : '');
  }

  function applyExtractResult(data: Partial<ExtractResponse>) {
    applyTimings(data.timings);
    const nextCandidates = data.candidates ?? [];
    const bestCandidate = nextCandidates[0] ?? null;
    setAudioUrl(bestCandidate?.audioUrl || data.audioUrl || '');
    setAudioPath(bestCandidate?.audioPath || data.audioPath || '');
    setTranscript(bestCandidate?.text || data.transcript || '');
    setCandidates(nextCandidates);
    setSelectedCandidateId(bestCandidate?.id ?? '');
    setConfig((value) => ({
      ...value,
      provider: 'cosyvoice',
      speakerId: '',
      promptAudioPath: bestCandidate?.audioPath || data.audioPath || value.promptAudioPath,
      promptText: bestCandidate?.text || data.transcript || value.promptText,
    }));
    setStatus(nextCandidates.length > 0 ? t('voice.candidateAutoSelected') : t('voice.noCandidates'));
  }

  function applyTimings(next?: TaskTiming[]) {
    const normalized = next ?? [];
    setTimings(normalized);
    if (normalized.length > 0) {
      console.table(normalized.map((item) => ({
        key: item.key,
        label: item.label,
        durationMs: item.durationMs,
        detail: item.detail ?? '',
      })));
    }
  }

  const pollJob = useCallback(async <T,>(
    jobId: string,
    onSuccess: (result: T, job: MaterialJobSnapshot<T>) => void,
  ): Promise<MaterialJobSnapshot<T>> => {
    activeJobIdRef.current = jobId;
    while (activeJobIdRef.current === jobId) {
      const response = await fetch(`/api/voice/cosyvoice/jobs/${encodeURIComponent(jobId)}`);
      const data = await response.json().catch(() => ({})) as { job?: MaterialJobSnapshot<T>; error?: string };
      if (!response.ok || !data.job) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      setActiveJob(data.job);
      if (data.job.status === 'succeeded') {
        activeJobIdRef.current = '';
        if (data.job.timings.length > 0) {
          applyTimings(data.job.timings);
        }
        onSuccess(data.job.result as T, data.job);
        return data.job;
      }
      if (data.job.status === 'failed') {
        activeJobIdRef.current = '';
        if (data.job.timings.length > 0) {
          applyTimings(data.job.timings);
        }
        throw new Error(data.job.error || 'Job failed');
      }

      await sleep(700);
    }

    throw new Error('Job polling stopped.');
  }, []);

  async function startJob<T>(
    response: Response,
    onSuccess: (result: T, job: MaterialJobSnapshot<T>) => void,
  ): Promise<MaterialJobSnapshot<T>> {
    const data = await response.json().catch(() => ({})) as { job?: MaterialJobSnapshot<T>; error?: string };
    if (!response.ok || !data.job) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    setActiveJob(data.job);
    return pollJob<T>(data.job.id, onSuccess);
  }

  async function extractMaterial() {
    if (!videoFile) {
      setStatus(t('voice.videoRequired'));
      return;
    }

    setExtracting(true);
    setStatus(t('voice.extracting'));
    setJobDialogOpen(true);
    setActiveJob(null);
    try {
      const form = new FormData();
      form.set('video', videoFile);
      form.set('enhanceVocals', enhanceVocals ? '1' : '0');
      const response = await fetch('/api/voice/cosyvoice/jobs/extract', {
        method: 'POST',
        body: form,
      });
      await startJob<ExtractResponse>(response, (result) => {
        applyExtractResult(result);
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Extract failed');
    } finally {
      setExtracting(false);
    }
  }

  async function probeResources() {
    if (!ytDlpStatus?.installed) {
      setResourceStatus(t('voice.ytDlpMissing'));
      return;
    }
    setProbing(true);
    setResourceStatus(t('voice.resourceProbing'));
    setResourceImportDone(false);
    setActiveJob(null);
    setResources([]);
    setSelectedFormatId('');
    try {
      const response = await fetch('/api/voice/cosyvoice/jobs/probe-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: resourceUrl, resourceType: 'audio' }),
      });
      await startJob<{ formats?: AudioResource[] }>(response, (result) => {
        const formats = result.formats ?? [];
        setResources(formats);
        setSelectedFormatId(formats[0]?.formatId ?? '');
        setResourceStatus(formats.length > 0 ? '' : t('voice.resourceEmpty'));
      });
    } catch (error) {
      setResourceStatus(error instanceof Error ? error.message : 'Probe failed');
    } finally {
      setProbing(false);
    }
  }

  async function refreshYtDlpStatus() {
    try {
      const response = await fetch('/api/voice/cosyvoice/yt-dlp/status');
      const data = await response.json().catch(() => ({})) as { status?: YtDlpStatus };
      if (data.status) {
        setYtDlpStatus(data.status);
      }
    } catch {
      setYtDlpStatus({ installed: false, bin: 'data/tools/bin/yt-dlp', version: null, error: 'status unavailable' });
    }
  }

  async function installYtDlp() {
    if (!window.confirm(t('voice.ytDlpInstallConfirm'))) return;

    setInstallingYtDlp(true);
    setResourceStatus(t('voice.ytDlpInstalling'));
    try {
      const response = await fetch('/api/voice/cosyvoice/yt-dlp/install', { method: 'POST' });
      const data = await response.json().catch(() => ({})) as { status?: YtDlpStatus; error?: string };
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      if (data.status) {
        setYtDlpStatus(data.status);
      }
      setResourceStatus(t('voice.ytDlpInstalled'));
    } catch (error) {
      setResourceStatus(error instanceof Error ? error.message : 'Install failed');
    } finally {
      setInstallingYtDlp(false);
    }
  }

  async function confirmResourceImport() {
    if (!selectedFormatId) return;

    setImporting(true);
    setResourceImportDone(false);
    setResourceStatus(t('voice.resourceImporting'));
    setActiveJob(null);
    try {
      const response = await fetch('/api/voice/cosyvoice/jobs/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: resourceUrl, formatId: selectedFormatId, enhanceVocals }),
      });
      await startJob<ExtractResponse>(response, (result) => {
        if (videoUrl.startsWith('blob:')) {
          URL.revokeObjectURL(videoUrl);
        }
        setVideoFile(null);
        setVideoUrl(result.videoUrl || '');
        applyExtractResult(result);
        setResourceImportDone(true);
        setResourceStatus(t('voice.resourceImportDone'));
      });
    } catch (error) {
      setResourceStatus(error instanceof Error ? error.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  function selectCandidate(candidate: MaterialCandidate) {
    setSelectedCandidateId(candidate.id);
    setAudioUrl(candidate.audioUrl);
    setAudioPath(candidate.audioPath);
    setTranscript(candidate.text);
    setConfig((value) => ({
      ...value,
      speakerId: '',
      promptAudioPath: candidate.audioPath,
      promptText: candidate.text,
    }));
    setStatus(t('voice.candidateSelected'));
  }

  function closeResourceDialog() {
    if (probing || importing) return;
    setResourceDialogOpen(false);
    setResourceUrl('');
    setResources([]);
    setSelectedFormatId('');
    setResourceStatus('');
    setProbing(false);
    setImporting(false);
    setResourceImportDone(false);
    if (resourceJobActive) {
      setActiveJob(null);
    }
  }

  function closeJobDialog() {
    if (extracting || saving) return;
    setJobDialogOpen(false);
    setActiveJob(null);
  }

  async function saveMaterial() {
    if (!transcript.trim()) {
      setStatus(t('voice.textRequired'));
      return;
    }

    setSaving(true);
    setStatus(t('voice.saving'));
    setJobDialogOpen(true);
    setActiveJob(null);
    try {
      const response = await fetch('/api/voice/cosyvoice/jobs/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          speakerName: config.speakerName,
          promptAudioPath: audioPath,
          promptText: transcript,
        }),
      });
      await startJob<{
        config?: VoiceConfig;
        speakers?: SpeakerProfile[];
        speaker?: SpeakerProfile;
        cached?: boolean;
        cacheWarning?: string;
        timings?: TaskTiming[];
        error?: string;
      }>(response, (result) => {
        if (result.config) {
          setConfig({ ...defaultConfig, ...result.config });
        }
        if (result.speakers) {
          setSpeakers(result.speakers);
        }
        if (result.speaker) {
          setConfig((value) => ({ ...value, speakerId: result.speaker!.id }));
        }
        setStatus(result.cached === false && result.cacheWarning
          ? `${t('voice.savedWithCacheWarning')} ${result.speaker?.id ?? ''} · ${result.cacheWarning}`
          : `${t('voice.saved')} ${result.speaker?.id ?? ''}`.trim());
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function applySpeaker(speakerId: string) {
    if (!speakerId) return;

    setApplyingSpeakerId(speakerId);
    setStatus(t('voice.speakerSwitching'));
    try {
      const response = await fetch('/api/voice/cosyvoice/speakers/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speakerId }),
      });
      const data = await response.json().catch(() => ({})) as { config?: VoiceConfig; speakers?: SpeakerProfile[]; timings?: TaskTiming[]; error?: string };
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      if (data.config) {
        setConfig({ ...defaultConfig, ...data.config });
        setAudioPath(data.config.promptAudioPath || '');
        setTranscript(data.config.promptText || '');
      }
      if (data.speakers) {
        setSpeakers(data.speakers);
      }
      applyTimings(data.timings);
      setStatus(t('voice.speakerSwitched'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Switch failed');
    } finally {
      setApplyingSpeakerId('');
    }
  }

  async function deleteSpeaker(speakerId: string) {
    if (!speakerId || !window.confirm(t('voice.deleteSpeakerConfirm'))) return;

    setDeletingSpeakerId(speakerId);
    try {
      const response = await fetch('/api/voice/cosyvoice/speakers/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speakerId }),
      });
      const data = await response.json().catch(() => ({})) as { config?: VoiceConfig; speakers?: SpeakerProfile[]; deleted?: boolean; error?: string };
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      if (data.config) {
        setConfig({ ...defaultConfig, ...data.config });
        setAudioPath(data.config.promptAudioPath || '');
        setTranscript(data.config.promptText || '');
      }
      setSpeakers(data.speakers ?? []);
      setStatus(t('voice.speakerDeleted'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Delete failed');
    } finally {
      setDeletingSpeakerId('');
    }
  }

  async function checkCosyVoice() {
    setCheckingCosyVoice(true);
    setStatus(t('voice.cosyvoiceChecking'));
    try {
      const response = await fetch('/api/voice/cosyvoice/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: config.baseUrl,
          endpoint: config.endpoint,
        }),
      });
      const data = await response.json().catch(() => ({})) as { status?: CosyVoiceServiceStatus };
      if (data.status?.ok) {
        setStatus(`${t('voice.cosyvoiceOnline')} ${data.status.url}`);
        return;
      }
      setStatus(`${t('voice.cosyvoiceOffline')} ${data.status?.error || `HTTP ${response.status}`}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('voice.cosyvoiceOffline'));
    } finally {
      setCheckingCosyVoice(false);
    }
  }

  return (
    <div className="grid min-h-[calc(100vh-8rem)] grid-cols-1 gap-4 xl:grid-cols-2">
      <section className="relative flex min-h-[320px] flex-col rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-white">{t('voice.videoTitle')}</h3>
            <button
              type="button"
              onClick={() => setResourceDialogOpen(true)}
              disabled={jobRunning}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 hover:border-indigo-500 disabled:cursor-not-allowed disabled:text-slate-500"
            >
              {t('voice.resourceLink')}
            </button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={extractMaterial}
              disabled={!canExtract}
              className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {extracting ? t('voice.extracting') : t('voice.extract')}
            </button>
          </div>
        </div>
        <label className="mb-3 inline-flex w-fit cursor-pointer items-center rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 hover:border-indigo-500">
          {t('voice.selectVideo')}
          <input type="file" accept="video/*,audio/*" className="hidden" onChange={handleVideoChange} />
        </label>
        <label className="mb-3 flex w-fit items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={enhanceVocals}
            onChange={(event) => setEnhanceVocals(event.target.checked)}
            className="h-4 w-4 rounded border-slate-700 bg-slate-950"
          />
          {t('voice.enhanceVocals')}
        </label>
        <div className="flex flex-1 items-center justify-center overflow-hidden rounded-md border border-slate-800 bg-black">
          {videoUrl ? (
            <video src={videoUrl} controls className="h-full max-h-[420px] w-full object-contain" />
          ) : (
            <div className="text-sm text-slate-500">{t('voice.videoRequired')}</div>
          )}
        </div>
      </section>

      <section className="flex min-h-[320px] flex-col rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-white">{t('voice.savedSpeakersTitle')}</h3>
          <div className="text-xs text-slate-500">{speakers.length ? `${speakers.length}` : ''}</div>
        </div>
        {speakers.length > 0 ? (
          <div className="flex-1 space-y-2 overflow-y-auto">
            {speakers.map((speaker) => {
              const active = speaker.id === config.speakerId;
              return (
                <div
                  key={speaker.id}
                  className={`rounded-md border p-3 ${active ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-800 bg-slate-950'}`}
                >
                  <div className="mb-1 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-100">{speaker.name}</div>
                      <div className="mt-1 truncate text-xs text-slate-500">{speaker.id}</div>
                    </div>
                    {active ? (
                      <span className="rounded bg-emerald-500/15 px-2 py-1 text-xs text-emerald-300">{t('voice.activeSpeaker')}</span>
                    ) : null}
                  </div>
                  <div className="mb-3 max-h-10 overflow-hidden text-xs leading-5 text-slate-400">{speaker.promptText}</div>
                  {speaker.promptAudioPath ? (
                    <audio
                      src={getCosyVoiceAudioUrl(speaker.promptAudioPath)}
                      controls
                      preload="none"
                      className="mb-3 w-full"
                    />
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => void deleteSpeaker(speaker.id)}
                      disabled={!!deletingSpeakerId || !!applyingSpeakerId}
                      className="rounded-md border border-red-500/40 px-3 py-2 text-sm text-red-300 transition hover:border-red-400 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
                    >
                      {deletingSpeakerId === speaker.id ? t('voice.deletingSpeaker') : t('voice.deleteSpeaker')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void applySpeaker(speaker.id)}
                      disabled={active || !!applyingSpeakerId || !!deletingSpeakerId}
                      className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                    >
                      {applyingSpeakerId === speaker.id ? t('voice.speakerSwitching') : t('voice.applySpeaker')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-md border border-slate-800 bg-slate-950 px-4 text-center text-sm text-slate-500">
            {t('voice.savedSpeakersEmpty')}
          </div>
        )}
      </section>

      {resourceDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-slate-700 bg-slate-950 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">{t('voice.resourceLink')}</h3>
              <button
                type="button"
                onClick={closeResourceDialog}
                disabled={probing || importing}
                className="text-sm text-slate-400 hover:text-white disabled:cursor-not-allowed disabled:text-slate-600"
              >
                {t('voice.cancel')}
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-[180px_1fr_auto]">
              <label className="text-xs text-slate-400">
                {t('voice.resourceType')}
                <select
                  value="audio"
                  disabled
                  className="mt-1 w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-300"
                >
                  <option value="audio">{t('voice.resourceTypeAudio')}</option>
                </select>
              </label>
              <label className="text-xs text-slate-400">
                {t('voice.resourceUrl')}
                <input
                  value={resourceUrl}
                  onChange={(event) => setResourceUrl(event.target.value)}
                  placeholder="https://..."
                  className="mt-1 w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
                />
              </label>
              <button
                type="button"
                onClick={probeResources}
                disabled={!resourceUrl.trim() || probing || importing || !ytDlpStatus?.installed}
                className="self-end rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                {probing ? t('voice.resourceProbing') : t('voice.resourceProbe')}
              </button>
            </div>
            {!ytDlpStatus?.installed && (
              <button
                type="button"
                onClick={installYtDlp}
                disabled={installingYtDlp}
                title={t('voice.ytDlpMissing')}
                className="mt-3 flex w-fit items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-300 hover:border-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-xs font-bold text-slate-950">!</span>
                <span>{installingYtDlp ? t('voice.ytDlpInstalling') : t('voice.ytDlpMissing')}</span>
              </button>
            )}
            <div className="mt-4 min-h-[220px] overflow-y-auto rounded-md border border-slate-800 bg-slate-900">
              {resourceProgressVisible ? (
                <div className="p-4">
                  <ProcessingProgress
                    job={activeJob}
                    t={t}
                    compact
                  />
                </div>
              ) : resources.length > 0 ? (
                <div className="divide-y divide-slate-800">
                  {resources.map((resource) => (
                    <label key={resource.formatId} className="flex cursor-pointer items-start gap-3 p-3 hover:bg-slate-800/70">
                      <input
                        type="radio"
                        name="audio-resource"
                        checked={selectedFormatId === resource.formatId}
                        onChange={() => setSelectedFormatId(resource.formatId)}
                        className="mt-1"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-3">
                          <span className="min-w-0 break-words text-sm font-medium text-slate-100">{resource.label}</span>
                          <audio
                            src={resource.previewUrl}
                            controls
                            preload="none"
                            className="h-9 w-44 shrink-0"
                            onPlay={() => setSelectedFormatId(resource.formatId)}
                          />
                        </span>
                        <span className="mt-1 block break-all text-xs text-slate-500">
                          {resource.formatId} · {resource.vcodec} · {resource.acodec} · {resource.protocol}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="flex h-[220px] items-center justify-center px-4 text-center text-sm text-slate-500">
                  {resourceStatus || t('voice.resourceEmpty')}
                </div>
              )}
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <div className="min-h-5 text-sm text-slate-400">{resourceStatus}</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={closeResourceDialog}
                  disabled={probing || importing}
                  className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:text-slate-500"
                >
                  {resourceImportDone ? t('voice.close') : t('voice.cancel')}
                </button>
                {!resourceImportDone ? (
                  <button
                    type="button"
                    onClick={confirmResourceImport}
                    disabled={!selectedFormatId || importing || probing}
                    className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                  >
                    {importing ? t('voice.resourceImporting') : t('voice.confirm')}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}

      {jobDialogOpen && activeJob && activeJob.type !== 'probe-url' && activeJob.type !== 'import-url' ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-slate-700 bg-slate-950 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">{t('voice.progressTitle')}</h3>
              <button
                type="button"
                onClick={closeJobDialog}
                disabled={extracting || saving}
                className="text-sm text-slate-400 hover:text-white disabled:cursor-not-allowed disabled:text-slate-600"
              >
                {t('voice.close')}
              </button>
            </div>
            <div className="overflow-y-auto">
              <ProcessingProgress job={activeJob} t={t} compact />
            </div>
          </div>
        </div>
      ) : null}

      <section className="flex min-h-[320px] flex-col rounded-lg border border-slate-800 bg-slate-900/60 p-4 xl:col-span-2">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-white">{t('voice.candidatesTitle')}</h3>
          <div className="text-xs text-slate-500">{candidates.length ? `${candidates.length}` : ''}</div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {candidates.length > 0 ? candidates.map((candidate) => (
            <div
              key={candidate.id}
              className={`rounded-lg border p-3 ${selectedCandidateId === candidate.id ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-800 bg-slate-950'}`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0 text-sm font-medium text-slate-100">
                  {candidate.speaker} · {(candidate.durationMs / 1000).toFixed(1)}s
                </div>
                <span className={`rounded px-2 py-1 text-xs ${candidate.quality === 'high' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                  {candidate.quality === 'high' ? t('voice.qualityHigh') : t('voice.qualityMedium')} · {Math.round(candidate.score * 100)}
                </span>
              </div>
              <audio src={candidate.audioUrl} controls preload="none" className="mb-2 w-full" />
              <div className="mb-3 min-h-12 text-sm leading-5 text-slate-300">{candidate.text}</div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-500">
                  {candidate.source === 'vocal' ? t('voice.sourceVocal') : t('voice.sourceRaw')}
                  {candidate.reasons.length > 0 ? ` · ${candidate.reasons.join(', ')}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => selectCandidate(candidate)}
                  className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"
                >
                  {selectedCandidateId === candidate.id ? t('voice.candidateSelected') : t('voice.useCandidate')}
                </button>
              </div>
            </div>
          )) : (
            <div className="flex min-h-[160px] items-center justify-center rounded-md border border-slate-800 bg-slate-950 px-4 text-center text-sm text-slate-500 md:col-span-2 xl:col-span-3">
              {t('voice.candidatesEmpty')}
            </div>
          )}
        </div>
      </section>

      <section className="flex min-h-[320px] flex-col rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-white">{t('voice.transcriptTitle')}</h3>
          <div className="text-xs text-slate-500">{config.speakerName}</div>
        </div>
        <textarea
          value={transcript}
          onChange={(event) => setTranscript(event.target.value)}
          placeholder={t('voice.transcriptPlaceholder')}
          className="min-h-[260px] flex-1 resize-none rounded-md border border-slate-800 bg-slate-950 p-3 text-sm leading-6 text-slate-100 outline-none focus:border-indigo-500"
        />
      </section>

      <section className="flex min-h-[260px] flex-col rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-white">{t('voice.audioTitle')}</h3>
        <div className="flex flex-1 flex-col justify-center rounded-md border border-slate-800 bg-slate-950 p-4">
          {displayAudioUrl ? (
            <>
              <audio src={displayAudioUrl} controls className="w-full" />
              <div className="mt-3 break-all text-xs text-slate-500">{audioPath}</div>
            </>
          ) : (
            <div className="text-sm text-slate-500">{t('voice.noAudio')}</div>
          )}
        </div>
      </section>

      <section className="flex min-h-[260px] flex-col rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-white">{t('voice.configTitle')}</h3>
        <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-2">
          <label className="text-xs text-slate-400 md:col-span-2">
            {t('voice.speakerName')}
            <input
              value={config.speakerName}
              onChange={(event) => setConfig((value) => ({ ...value, speakerName: event.target.value }))}
              placeholder={t('voice.speakerNamePlaceholder')}
              className="mt-1 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="text-xs text-slate-400">
            {t('voice.provider')}
            <select
              value={config.provider}
              onChange={(event) => setConfig((value) => ({ ...value, provider: event.target.value as VoiceProvider }))}
              className="mt-1 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
            >
              <option value="cosyvoice">CosyVoice</option>
              <option value="say">say</option>
            </select>
          </label>
          <label className="text-xs text-slate-400">
            {t('voice.timeout')}
            <input
              type="number"
              min={1000}
              step={1000}
              value={config.timeoutMs}
              onChange={(event) => setConfig((value) => ({ ...value, timeoutMs: Number(event.target.value) }))}
              className="mt-1 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="text-xs text-slate-400 md:col-span-2">
            {t('voice.baseUrl')}
            <input
              value={config.baseUrl}
              onChange={(event) => setConfig((value) => ({ ...value, baseUrl: event.target.value }))}
              className="mt-1 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="text-xs text-slate-400 md:col-span-2">
            {t('voice.endpoint')}
            <input
              value={config.endpoint}
              onChange={(event) => setConfig((value) => ({ ...value, endpoint: event.target.value }))}
              className="mt-1 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={config.fallbackToSay}
              onChange={(event) => setConfig((value) => ({ ...value, fallbackToSay: event.target.checked }))}
              className="h-4 w-4 rounded border-slate-700 bg-slate-950"
            />
            {t('voice.fallback')}
          </label>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="min-h-5 text-sm text-slate-400">{status}</div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={checkCosyVoice}
              disabled={checkingCosyVoice}
              className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 transition hover:border-indigo-500 disabled:cursor-not-allowed disabled:text-slate-500"
            >
              {checkingCosyVoice ? t('voice.cosyvoiceChecking') : t('voice.cosyvoiceCheck')}
            </button>
            <button
              type="button"
              onClick={saveMaterial}
              disabled={!canSave}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {saving ? t('voice.saving') : t('voice.save')}
            </button>
          </div>
        </div>
      </section>

    </div>
  );
};

function getCosyVoiceAudioUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const unifiedCosyMarker = '/data/voice/cosyvoice/';
  const unifiedAssetMarker = '/data/voice/assets/';
  const unifiedCosyIndex = normalized.indexOf(unifiedCosyMarker);
  const unifiedAssetIndex = normalized.indexOf(unifiedAssetMarker);
  const relativePath = unifiedCosyIndex >= 0
    ? normalized.slice(unifiedCosyIndex + unifiedCosyMarker.length)
    : unifiedAssetIndex >= 0
      ? `voice-assets/${normalized.slice(unifiedAssetIndex + unifiedAssetMarker.length)}`
      : normalized.startsWith('data/voice/assets/')
        ? `voice-assets/${normalized.slice('data/voice/assets/'.length)}`
        : normalized.startsWith('data/voice/cosyvoice/')
          ? normalized.slice('data/voice/cosyvoice/'.length)
          : normalized.split('/').pop() ?? '';
  return relativePath ? `/api/voice/cosyvoice/audio/${encodeURIComponent(relativePath)}` : '';
}

function ProcessingProgress({
  job,
  t,
  compact = false,
}: {
  job: MaterialJobSnapshot | null;
  t: (key: TranslationKey) => string;
  compact?: boolean;
}) {
  if (!job) {
    return (
      <section className={`rounded-lg border border-slate-800 bg-slate-900/60 p-4 ${compact ? '' : 'xl:col-span-2'}`}>
        <div className="text-sm text-slate-400">{t('voice.progressWorking')}</div>
      </section>
    );
  }

  const failed = job.status === 'failed';
  const currentStage = job.stages.find(stage => stage.key === job.stageKey)
    ?? job.stages.find(stage => stage.status === 'running')
    ?? job.stages[0];
  const label = failed
    ? t('voice.progressFailed')
    : job.status === 'succeeded'
      ? t('voice.progressDone')
      : t(getProgressLabel(currentStage?.key ?? job.stageKey));

  return (
    <section className={`rounded-lg border border-slate-800 bg-slate-900/60 p-4 ${compact ? '' : 'xl:col-span-2'}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">{t('voice.progressTitle')}</h3>
        <span className={`font-mono text-sm ${failed ? 'text-red-300' : 'text-emerald-300'}`}>{Math.round(job.percent)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-all duration-500 ${failed ? 'bg-red-500' : 'bg-emerald-500'}`}
          style={{ width: `${Math.max(0, Math.min(100, job.percent))}%` }}
        />
      </div>
      <div className="mt-2 text-sm text-slate-300">{label}</div>
      <div className={`mt-4 grid gap-2 ${compact ? 'md:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-3'}`}>
        {job.stages.map((stage) => {
          const done = stage.status === 'done' || stage.status === 'running' || stage.status === 'failed';
          const stageFailed = stage.status === 'failed';
          return (
            <div
              key={stage.key}
              className={`rounded-md border p-3 ${
                stageFailed
                  ? 'border-red-500/40 bg-red-500/10'
                  : done
                    ? 'border-emerald-500/40 bg-emerald-500/10'
                    : 'border-slate-800 bg-slate-950'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-slate-200">{t(getProgressLabel(stage.key))}</span>
                <span className="font-mono text-xs text-slate-400">{formatStageProgressValue(stage)}</span>
              </div>
              {stage.detail ? <div className="mt-1 truncate text-xs text-slate-500">{stage.detail}</div> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function getProgressLabel(stageKey: string): TranslationKey {
  switch (stageKey) {
    case 'upload':
      return 'voice.progressUpload';
    case 'validate_url':
      return 'voice.progressValidateUrl';
    case 'yt_dlp_probe':
      return 'voice.progressProbe';
    case 'parse_formats':
      return 'voice.progressParseFormats';
    case 'download':
      return 'voice.progressDownload';
    case 'extract_wav':
      return 'voice.progressExtract';
    case 'mdx_separation':
      return 'voice.progressSeparate';
    case 'funasr_analyze':
      return 'voice.progressAnalyze';
    case 'candidate_filter':
      return 'voice.progressCandidateFilter';
    case 'candidate_cut':
    case 'candidate_export':
      return 'voice.progressCandidates';
    case 'save_profile':
      return 'voice.progressSaveProfile';
    case 'cache_speaker':
      return 'voice.progressCacheSpeaker';
    case 'apply_config':
      return 'voice.progressApplyConfig';
    case 'wake_ack_prewarm':
      return 'voice.progressWakeAck';
    case 'voice_asset_index':
      return 'voice.progressVoiceAsset';
    case 'cleanup':
      return 'voice.progressCleanup';
    case 'done':
      return 'voice.progressDone';
    default:
      return 'voice.progressWorking';
  }
}

function formatDurationMs(durationMs: number): string {
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)}s`;
  return `${Math.round(durationMs)}ms`;
}

function formatStageProgressValue(stage: MaterialJobStage): string {
  if (stage.durationMs !== undefined) return formatDurationMs(stage.durationMs);
  if (stage.status === 'running' && stage.elapsedMs !== undefined) return formatDurationMs(stage.elapsedMs);
  return '--';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
