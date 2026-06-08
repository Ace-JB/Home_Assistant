import { serve } from 'bun';
import type { Server, ServerWebSocket } from 'bun';
import { GLOBAL_CONFIG } from '@/global_config';
import type { VisionProfile } from '@/shared/vision/types';

export type SocketClientData = {
    id: string;
    connectedAt: number;
};

export type AssistantLanguage = 'zh' | 'en';
export type VoiceSessionMode = 'standby' | 'awake' | 'listening' | 'processing' | 'speaking';

type SocketMessage =
    | { type: 'socket.connected'; ts: number; clientId: string; clients: number; language: AssistantLanguage; voiceSessionMode: VoiceSessionMode }
    | { type: 'socket.status'; ts: number; clients: number; language: AssistantLanguage; voiceSessionMode: VoiceSessionMode }
    | { type: 'video.frame'; ts: number; mime: 'image/jpeg'; data: string; meta?: unknown }
    | { type: 'voice.level'; ts: number; bytes: number; rms: number; peak: number }
    | { type: 'voice.text'; ts: number; text: string; startTs: number; endTs: number }
    | { type: 'voice.session'; ts: number; mode: VoiceSessionMode; reason: string; conversationId?: string | null; pipelineId?: string | null }
    | {
        type: 'vision.detection';
        ts: number;
        profile: VisionProfile;
        requestedProfile: VisionProfile;
        degraded: boolean;
        degradeReason?: string;
        faces: any[];
        bodies: any[];
        hands: any[];
        objects: any[];
    };

type SocketCommand =
    | { type: 'language.set'; language: AssistantLanguage }
    | { type: 'ping' };

const SOCKET_PATH = '/ws/realtime';
const clients = new Set<ServerWebSocket<SocketClientData>>();
let standaloneServer: Server<SocketClientData> | null = null;
let assistantLanguage: AssistantLanguage = 'zh';
let voiceSessionMode: VoiceSessionMode = 'standby';

function createClientId(): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function send(ws: ServerWebSocket<SocketClientData>, message: SocketMessage | string): void {
    if (ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    ws.send(payload);
}

function broadcast(message: SocketMessage): void {
    if (clients.size === 0) return;
    
    const serialized = JSON.stringify(message);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(serialized);
        }
    }
}

function parseCommand(message: string | Buffer): SocketCommand | null {
    const raw = message.toString();

    if (raw === 'ping') {
        return { type: 'ping' };
    }

    try {
        const parsed = JSON.parse(raw) as Partial<SocketCommand>;
        if (parsed.type === 'language.set' && (parsed.language === 'zh' || parsed.language === 'en')) {
            return parsed as SocketCommand;
        }
    } catch {
        return null;
    }

    return null;
}

export function calculatePcmLevel(audio: Buffer): { rms: number; peak: number } {
    if (audio.length < 2) {
        return { rms: 0, peak: 0 };
    }

    let sumSquares = 0;
    let peak = 0;
    const sampleCount = Math.floor(audio.length / 2);

    for (let i = 0; i < sampleCount; i++) {
        const sample = audio.readInt16LE(i * 2) / 32768;
        const abs = Math.abs(sample);
        sumSquares += sample * sample;
        if (abs > peak) {
            peak = abs;
        }
    }

    return {
        rms: Math.sqrt(sumSquares / sampleCount),
        peak,
    };
}

export const realtimeSocket = {
    path: SOCKET_PATH,

    upgrade(req: Request, server: Server<SocketClientData>): Response | undefined {
        const upgraded = server.upgrade(req, {
            data: {
                id: createClientId(),
                connectedAt: Date.now(),
            },
        });

        if (upgraded) {
            return undefined;
        }

        return new Response('WebSocket upgrade failed', { status: 400 });
    },

    websocket: {
        open(ws: ServerWebSocket<SocketClientData>) {
            clients.add(ws);
            send(ws, {
                type: 'socket.connected',
                ts: Date.now(),
                clientId: ws.data.id,
                clients: clients.size,
                language: assistantLanguage,
                voiceSessionMode,
            });
            realtimeSocket.publishStatus();
        },

        message(ws: ServerWebSocket<SocketClientData>, message: string | Buffer) {
            const command = parseCommand(message);

            if (command?.type === 'ping') {
                send(ws, {
                    type: 'socket.status',
                    ts: Date.now(),
                    clients: clients.size,
                    language: assistantLanguage,
                    voiceSessionMode,
                });
                return;
            }

            if (command?.type === 'language.set') {
                assistantLanguage = command.language;
                realtimeSocket.publishStatus();
            }
        },

        close(ws: ServerWebSocket<SocketClientData>) {
            clients.delete(ws);
            realtimeSocket.publishStatus();
        },
    },

    publishStatus(): void {
        for (const client of clients) {
            send(client, {
                type: 'socket.status',
                ts: Date.now(),
                clients: clients.size,
                language: assistantLanguage,
                voiceSessionMode,
            });
        }
    },

    getAssistantLanguage(): AssistantLanguage {
        return assistantLanguage;
    },

    publishVoiceSession(input: {
        mode: VoiceSessionMode;
        reason: string;
        conversationId?: string | null;
        pipelineId?: string | null;
    }): void {
        if (voiceSessionMode === input.mode) {
            return;
        }
        voiceSessionMode = input.mode;
        broadcast({
            type: 'voice.session',
            ts: Date.now(),
            mode: input.mode,
            reason: input.reason,
            conversationId: input.conversationId ?? null,
            pipelineId: input.pipelineId ?? null,
        });
        realtimeSocket.publishStatus();
    },

    publishVideoFrame(frame: Buffer, meta?: unknown): void {
        const now = Date.now();
        broadcast({
            type: 'video.frame',
            ts: now,
            mime: 'image/jpeg',
            data: frame.toString('base64'),
            meta,
        });
    },

    publishVoiceChunk(audio: Buffer): void {
        const level = calculatePcmLevel(audio);
        broadcast({
            type: 'voice.level',
            ts: Date.now(),
            bytes: audio.length,
            ...level,
        });
    },

    publishVoiceText(text: string, startTs: number = Date.now(), endTs: number = Date.now()): void {
        const normalized = text.trim();
        if (!normalized) {
            return;
        }

        broadcast({
            type: 'voice.text',
            ts: Date.now(),
            text: normalized,
            startTs,
            endTs,
        });
    },

    publishVisionDetection(detection: {
        profile: VisionProfile;
        requestedProfile: VisionProfile;
        degraded: boolean;
        degradeReason?: string;
        faces: any[];
        bodies: any[];
        hands: any[];
        objects: any[];
        ts: number;
    }): void {
        if (clients.size === 0) return;
        broadcast({
            type: 'vision.detection',
            ts: detection.ts,
            profile: detection.profile,
            requestedProfile: detection.requestedProfile,
            degraded: detection.degraded,
            ...(detection.degradeReason ? { degradeReason: detection.degradeReason } : {}),
            faces: detection.faces,
            bodies: detection.bodies,
            hands: detection.hands,
            objects: detection.objects,
        });
    },
};

export function startRealtimeSocketServer(port: number = GLOBAL_CONFIG.SERVER.SOCKET_PORT): Server<SocketClientData> {
    if (standaloneServer) {
        return standaloneServer;
    }

    standaloneServer = serve<SocketClientData>({
        port,

        fetch(req, server) {
            const url = new URL(req.url);
            if (url.pathname === realtimeSocket.path) {
                return realtimeSocket.upgrade(req, server);
            }

            return new Response('Realtime socket server', { status: 200 });
        },

        websocket: realtimeSocket.websocket,
    });

    console.log(`🔌 Realtime socket server running at ws://localhost:${port}${realtimeSocket.path}`);
    return standaloneServer;
}

export function stopRealtimeSocketServer(): void {
    for (const client of clients) {
        try {
            client.close();
        } catch (error) {
            console.warn('[Socket] failed to close realtime client:', error);
        }
    }
    clients.clear();

    if (standaloneServer) {
        standaloneServer.stop(true);
        standaloneServer = null;
    }
}
