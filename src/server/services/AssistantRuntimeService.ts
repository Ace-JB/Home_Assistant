export type AssistantRuntimeStatusValue = 'stopped' | 'starting' | 'running' | 'stopping' | 'degraded' | 'error';
export type AssistantRuntimeMode = 'minimal' | 'full';
export type AssistantRuntimeMonitorMode = 'audio' | 'full';
export type AssistantRuntimeAction = 'start' | 'stop';
export type AssistantRuntimeOptionalService = 'cosyvoice' | 'live-vision' | 'voice-separation';
export type AssistantRuntimeTaskStatus = 'pending' | 'running' | 'ready' | 'failed' | 'skipped' | 'stopping' | 'stopped';
export type AssistantRuntimeOperationType = 'start' | 'stop';
export type AssistantRuntimeOperationPhase = 'running' | 'completed' | 'failed';

export type AssistantRuntimeTask = {
    id: 'assistant-runtime' | 'funasr' | 'qwen-router' | 'qwen-vlm' | 'audio-monitor' | 'realtime-socket' | 'webrtc' | 'live-vision' | 'cosyvoice' | 'voice-separation';
    label: string;
    group: 'core' | 'optional';
    status: AssistantRuntimeTaskStatus;
    required: boolean;
    selected: boolean;
    message?: string;
};

export type AssistantRuntimeOperation = {
    type: AssistantRuntimeOperationType;
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

export type AssistantRuntimeDeps = {
    startMonitor: (mode: AssistantRuntimeMonitorMode) => Promise<void>;
    stopMonitor: () => Promise<void>;
    startFunASR: () => Promise<void>;
    startRouterModel: () => Promise<void>;
    startMainModel: () => Promise<void>;
    startCosyVoice: () => Promise<void>;
    startVoiceSeparation: () => Promise<void>;
    stopPythonServices: () => Promise<void>;
    startWebRTC: () => void | Promise<void>;
    stopRealtimeSocket: () => void | Promise<void>;
    stopWebRTC: () => void | Promise<void>;
    now: () => number;
    log: (event: string, metadata?: Record<string, unknown>) => void;
};

const DEFAULT_SERVICE_STATES: AssistantRuntimeServiceState[] = [
    { id: 'monitor', status: 'stopped', message: null },
    { id: 'realtime-socket', status: 'stopped', message: null },
    { id: 'webrtc', status: 'stopped', message: null },
    { id: 'python-services', status: 'stopped', message: null },
];

export class AssistantRuntimeService {
    private status: AssistantRuntimeStatusValue = 'stopped';
    private mode: AssistantRuntimeMode = 'minimal';
    private activeMode: AssistantRuntimeMode | null = null;
    private startedAt: number | null = null;
    private lastError: string | null = null;
    private degradedReasons: string[] = [];
    private services: AssistantRuntimeServiceState[] = cloneServiceStates(DEFAULT_SERVICE_STATES);
    private tasks: AssistantRuntimeTask[] = createRuntimeTasks('minimal', []);
    private operation: AssistantRuntimeOperation | null = null;
    private startPromise: Promise<AssistantRuntimeStatus> | null = null;
    private stopPromise: Promise<AssistantRuntimeStatus> | null = null;

    constructor(private readonly deps: AssistantRuntimeDeps) {}

    getStatus(): AssistantRuntimeStatus {
        return this.snapshot();
    }

    async start(input: AssistantRuntimeMode | AssistantRuntimeStartInput = {}): Promise<AssistantRuntimeStatus> {
        if (this.status === 'running' || this.status === 'degraded') return this.snapshot();
        if (this.status === 'starting' && this.startPromise) return this.startPromise;
        if (this.status === 'stopping') throw new Error('Assistant runtime is stopping.');

        const options = normalizeStartInput(input);
        const mode = resolveStartMode(options);
        this.status = 'starting';
        this.mode = mode;
        this.activeMode = null;
        this.lastError = null;
        this.degradedReasons = [];
        this.tasks = createRuntimeTasks(mode, options.optionalServices);
        this.operation = { type: 'start', phase: 'running', tasks: cloneTasks(this.tasks) };
        this.services = this.services.map(service => ({
            ...service,
            status: service.id === 'webrtc' && mode !== 'full' ? 'stopped' : 'starting',
            message: null,
        }));
        this.deps.log('assistant_runtime.starting', { mode, optionalServices: options.optionalServices });

        this.startPromise = this.runStart(mode);
        try {
            return await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    async stop(): Promise<AssistantRuntimeStatus> {
        if (this.status === 'stopped') return this.snapshot();
        if (this.status === 'stopping' && this.stopPromise) return this.stopPromise;
        if (this.status === 'starting') throw new Error('Assistant runtime is starting.');

        this.status = 'stopping';
        this.deps.log('assistant_runtime.stopping', { mode: this.activeMode });
        this.tasks = this.tasks.map(task => (
            task.selected && task.status !== 'skipped'
                ? { ...task, status: 'stopping', message: undefined }
                : task
        ));
        this.operation = { type: 'stop', phase: 'running', tasks: cloneTasks(this.tasks) };
        this.services = this.services.map(service => ({
            ...service,
            status: service.status === 'stopped' ? 'stopped' : 'stopping',
        }));

        this.stopPromise = this.runStop();
        try {
            return await this.stopPromise;
        } finally {
            this.stopPromise = null;
        }
    }

    private async runStart(mode: AssistantRuntimeMode): Promise<AssistantRuntimeStatus> {
        try {
            this.setTaskStatus('assistant-runtime', 'running');
            this.setTaskStatus('funasr', 'running');
            await this.deps.startFunASR();
            this.setTaskStatus('funasr', 'ready');

            this.setTaskStatus('qwen-router', 'running');
            await this.deps.startRouterModel();
            this.setTaskStatus('qwen-router', 'ready');

            this.setTaskStatus('qwen-vlm', 'running');
            await this.deps.startMainModel();
            this.setTaskStatus('qwen-vlm', 'ready');
        } catch (error) {
            const message = normalizeError(error);
            this.status = 'error';
            this.lastError = message;
            const runningTask = this.tasks.find(task => task.status === 'running' && task.group === 'core' && task.id !== 'assistant-runtime');
            this.setTaskStatus(runningTask?.id ?? 'funasr', 'failed', message);
            this.setServiceState('python-services', 'error', message);
            await this.cleanupAfterFailedStart();
            this.finishOperation('failed');
            this.deps.log('assistant_runtime.start_failed', { mode, error: message });
            return this.snapshot();
        }

        await this.runOptionalStartTask('cosyvoice', this.deps.startCosyVoice);
        await this.runOptionalStartTask('voice-separation', this.deps.startVoiceSeparation);
        if (mode === 'full') {
            await this.runOptionalStartTask('webrtc', this.deps.startWebRTC);
        }

        try {
            this.setTaskStatus('audio-monitor', 'running');
            if (mode === 'full') this.setTaskStatus('live-vision', 'running');
            await this.deps.startMonitor(mode === 'full' ? 'full' : 'audio');
            const now = this.deps.now();
            this.startedAt = now;
            this.activeMode = mode;
            this.setTaskStatus('assistant-runtime', 'ready');
            this.setTaskStatus('audio-monitor', 'ready');
            this.setTaskStatus('realtime-socket', 'ready');
            if (mode === 'full') this.setTaskStatus('live-vision', 'ready');
            this.setServiceState('monitor', 'running');
            this.setServiceState('realtime-socket', 'running');
            this.setServiceState('python-services', this.degradedReasons.length > 0 ? 'degraded' : 'running', this.degradedReasons.join('; ') || null);
            this.status = this.degradedReasons.length > 0 ? 'degraded' : 'running';
            this.finishOperation('completed');
            this.deps.log('assistant_runtime.started', { mode, status: this.status, degradedReasons: this.degradedReasons });
            return this.snapshot();
        } catch (error) {
            const message = normalizeError(error);
            this.status = 'error';
            this.activeMode = null;
            this.startedAt = null;
            this.lastError = message;
            this.setServiceState('monitor', 'error', message);
            this.setTaskStatus('audio-monitor', 'failed', message);
            if (mode === 'full') this.setTaskStatus('live-vision', 'failed', message);
            await this.cleanupAfterFailedStart();
            this.finishOperation('failed');
            this.deps.log('assistant_runtime.start_failed', { mode, error: message });
            return this.snapshot();
        }
    }

    private async runStop(): Promise<AssistantRuntimeStatus> {
        const errors: string[] = [];
        const collect = async (id: AssistantRuntimeServiceState['id'], fn: () => void | Promise<void>) => {
            try {
                await fn();
                this.setServiceState(id, 'stopped');
            } catch (error) {
                const message = normalizeError(error);
                errors.push(`${id}: ${message}`);
                this.setServiceState(id, 'error', message);
            }
        };

        await collect('monitor', this.deps.stopMonitor);
        await collect('realtime-socket', this.deps.stopRealtimeSocket);
        await collect('webrtc', this.deps.stopWebRTC);
        await collect('python-services', this.deps.stopPythonServices);

        this.activeMode = null;
        this.startedAt = null;
        this.degradedReasons = [];
        this.lastError = errors.length > 0 ? errors.join('; ') : null;
        this.status = errors.length > 0 ? 'error' : 'stopped';
        this.tasks = this.tasks.map(task => ({ ...task, status: task.selected ? 'stopped' : 'skipped', message: undefined }));
        this.finishOperation(errors.length > 0 ? 'failed' : 'completed');
        this.deps.log('assistant_runtime.stopped', { status: this.status, error: this.lastError });
        return this.snapshot();
    }

    private async cleanupAfterFailedStart(): Promise<void> {
        await this.deps.stopMonitor().catch(() => undefined);
        await Promise.resolve(this.deps.stopRealtimeSocket()).catch(() => undefined);
        await Promise.resolve(this.deps.stopWebRTC()).catch(() => undefined);
        await this.deps.stopPythonServices().catch(() => undefined);
        this.setServiceState('realtime-socket', 'stopped');
        this.setServiceState('webrtc', 'stopped');
        this.setServiceState('python-services', 'stopped');
    }

    private async runOptionalStartTask(id: AssistantRuntimeTask['id'], fn: () => void | Promise<void>): Promise<void> {
        const task = this.tasks.find(item => item.id === id);
        if (!task?.selected) return;
        try {
            this.setTaskStatus(id, 'running');
            await fn();
            this.setTaskStatus(id, 'ready');
            if (id === 'webrtc') this.setServiceState('webrtc', 'running');
        } catch (error) {
            const message = normalizeError(error);
            this.degradedReasons = [...this.degradedReasons, `${task.label}: ${message}`];
            this.setTaskStatus(id, 'failed', message);
            if (id === 'webrtc') this.setServiceState('webrtc', 'degraded', message);
        }
    }

    private setServiceState(id: AssistantRuntimeServiceState['id'], status: AssistantRuntimeStatusValue, message: string | null = null): void {
        this.services = this.services.map(service => service.id === id ? { ...service, status, message } : service);
    }

    private setTaskStatus(id: AssistantRuntimeTask['id'], status: AssistantRuntimeTaskStatus, message?: string): void {
        this.tasks = this.tasks.map(task => task.id === id ? { ...task, status, ...(message ? { message } : { message: undefined }) } : task);
        if (this.operation) {
            this.operation = { ...this.operation, tasks: cloneTasks(this.tasks) };
        }
    }

    private finishOperation(phase: AssistantRuntimeOperationPhase): void {
        if (this.operation) {
            this.operation = { ...this.operation, phase, tasks: cloneTasks(this.tasks) };
        }
    }

    private snapshot(): AssistantRuntimeStatus {
        const now = this.deps.now();
        return {
            status: this.status,
            mode: this.mode,
            activeMode: this.activeMode,
            startedAt: this.startedAt,
            uptimeSeconds: this.startedAt === null ? null : Math.max(0, Math.floor((now - this.startedAt) / 1000)),
            lastError: this.lastError,
            degradedReasons: [...this.degradedReasons],
            actions: getActions(this.status),
            services: this.services.map(service => ({ ...service })),
            tasks: cloneTasks(this.tasks),
            operation: this.operation ? { ...this.operation, tasks: cloneTasks(this.operation.tasks) } : null,
        };
    }
}

function getActions(status: AssistantRuntimeStatusValue): AssistantRuntimeAction[] {
    if (status === 'running' || status === 'degraded') return ['stop'];
    if (status === 'starting' || status === 'stopping') return [];
    return ['start'];
}

export function isAssistantRuntimeAvailable(status: AssistantRuntimeStatus | AssistantRuntimeStatusValue): boolean {
    const value = typeof status === 'string' ? status : status.status;
    return value === 'running' || value === 'degraded';
}

function cloneServiceStates(states: AssistantRuntimeServiceState[]): AssistantRuntimeServiceState[] {
    return states.map(state => ({ ...state }));
}

function cloneTasks(tasks: AssistantRuntimeTask[]): AssistantRuntimeTask[] {
    return tasks.map(task => ({ ...task }));
}

function normalizeStartInput(input: AssistantRuntimeMode | AssistantRuntimeStartInput): Required<AssistantRuntimeStartInput> {
    if (typeof input === 'string') {
        return { mode: input, optionalServices: input === 'full' ? ['live-vision'] : [] };
    }
    return {
        mode: input.mode ?? 'minimal',
        optionalServices: input.optionalServices ?? [],
    };
}

function resolveStartMode(input: Required<AssistantRuntimeStartInput>): AssistantRuntimeMode {
    if (input.mode === 'full' || input.optionalServices.includes('live-vision')) return 'full';
    return 'minimal';
}

function createRuntimeTasks(mode: AssistantRuntimeMode, optionalServices: AssistantRuntimeOptionalService[]): AssistantRuntimeTask[] {
    const optional = new Set(optionalServices);
    const full = mode === 'full' || optional.has('live-vision');
    return [
        createTask('assistant-runtime', 'Assistant Runtime', 'core', true, true),
        createTask('funasr', 'Voice ASR / FunASR', 'core', true, true),
        createTask('qwen-router', 'Qwen Router Model', 'core', true, true),
        createTask('qwen-vlm', 'Qwen Main Model', 'core', true, true),
        createTask('audio-monitor', 'Audio Monitor / Wake ASR', 'core', true, true),
        createTask('realtime-socket', 'Realtime Socket', 'core', true, true),
        createTask('cosyvoice', 'CosyVoice TTS', 'optional', false, optional.has('cosyvoice')),
        createTask('live-vision', 'Live / Vision', 'optional', false, full),
        createTask('webrtc', 'WebRTC Stream', 'optional', false, full),
        createTask('voice-separation', 'MDX Voice Separation', 'optional', false, optional.has('voice-separation')),
    ];
}

function createTask(
    id: AssistantRuntimeTask['id'],
    label: string,
    group: AssistantRuntimeTask['group'],
    required: boolean,
    selected: boolean,
): AssistantRuntimeTask {
    return {
        id,
        label,
        group,
        required,
        selected,
        status: selected ? 'pending' : 'skipped',
    };
}

function normalizeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const ASSISTANT_RUNTIME_KEY = Symbol.for('home-assistant.assistantRuntime');

export function getAssistantRuntimeService(factory?: () => AssistantRuntimeService): AssistantRuntimeService {
    const globalScope = globalThis as typeof globalThis & { [ASSISTANT_RUNTIME_KEY]?: AssistantRuntimeService };
    if (!globalScope[ASSISTANT_RUNTIME_KEY]) {
        if (!factory) throw new Error('Assistant runtime service has not been initialized.');
        globalScope[ASSISTANT_RUNTIME_KEY] = factory();
    }
    return globalScope[ASSISTANT_RUNTIME_KEY]!;
}

export function getAssistantRuntimeServiceIfInitialized(): AssistantRuntimeService | null {
    const globalScope = globalThis as typeof globalThis & { [ASSISTANT_RUNTIME_KEY]?: AssistantRuntimeService };
    return globalScope[ASSISTANT_RUNTIME_KEY] ?? null;
}

export function __setAssistantRuntimeServiceForTest(service: AssistantRuntimeService | null): void {
    if (process.env.NODE_ENV !== 'test') {
        throw new Error('__setAssistantRuntimeServiceForTest is only available in test.');
    }
    const globalScope = globalThis as typeof globalThis & { [ASSISTANT_RUNTIME_KEY]?: AssistantRuntimeService };
    if (service) globalScope[ASSISTANT_RUNTIME_KEY] = service;
    else delete globalScope[ASSISTANT_RUNTIME_KEY];
}
