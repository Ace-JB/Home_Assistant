import { describe, expect, test } from "bun:test";
import { calculatePcmLevel, realtimeSocket, stopRealtimeSocketServer } from "@tools/Socket";
import { measurePerformance } from "./performance_utils";

function createFakeSocket(id = crypto.randomUUID()) {
    const sent: string[] = [];
    const ws = {
        readyState: WebSocket.OPEN,
        data: {
            id,
            connectedAt: Date.now(),
        },
        send(payload: string) {
            sent.push(payload);
        },
    };

    return { ws: ws as any, sent };
}

function parseSentMessages(sent: string[]) {
    return sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe("Socket Utils", () => {
    test("should calculate PCM level and measure performance", async () => {
        const audio = Buffer.alloc(16000 * 2); // 1 second of silence
        for (let i = 0; i < audio.length; i += 2) {
            audio.writeInt16LE(Math.floor(Math.random() * 32767), i);
        }

        const { result, duration } = await measurePerformance("Socket.calculatePcmLevel", async () => {
            return calculatePcmLevel(audio);
        });

        expect(result.rms).toBeGreaterThan(0);
        expect(result.peak).toBeGreaterThan(0);
    });

    test("should ignore legacy subtitle enable commands without publishing status", () => {
        const { ws, sent } = createFakeSocket();
        realtimeSocket.websocket.open(ws);
        sent.length = 0;

        realtimeSocket.websocket.message(ws, JSON.stringify({ type: "subtitle.enable", enabled: false }));

        expect(sent).toHaveLength(0);
        realtimeSocket.websocket.close(ws);
    });

    test("should omit realtime subtitle state from connection status messages", () => {
        const { ws, sent } = createFakeSocket();
        realtimeSocket.websocket.open(ws);

        const messages = parseSentMessages(sent);
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.every((message) => !("realtimeSubtitleEnabled" in message))).toBe(true);

        realtimeSocket.websocket.close(ws);
    });

    test("should publish voice text by default", () => {
        const { ws, sent } = createFakeSocket();
        realtimeSocket.websocket.open(ws);
        sent.length = 0;

        realtimeSocket.publishVoiceText("hello", 1000, 1200);

        const messages = parseSentMessages(sent);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            type: "voice.text",
            text: "hello",
            startTs: 1000,
            endTs: 1200,
        });
        realtimeSocket.websocket.close(ws);
    });

    test("should publish vision detection profile metadata", () => {
        const { ws, sent } = createFakeSocket();
        realtimeSocket.websocket.open(ws);
        sent.length = 0;

        realtimeSocket.publishVisionDetection({
            ts: 2000,
            profile: "identity",
            requestedProfile: "full",
            degraded: true,
            degradeReason: "full_not_ready",
            faces: [],
            bodies: [],
            hands: [],
            objects: [],
        });

        const messages = parseSentMessages(sent);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            type: "vision.detection",
            ts: 2000,
            profile: "identity",
            requestedProfile: "full",
            degraded: true,
            degradeReason: "full_not_ready",
        });
        realtimeSocket.websocket.close(ws);
    });

    test("should close tracked clients when stopping realtime socket server", () => {
        const closeCalls: number[] = [];
        const { ws } = createFakeSocket();
        (ws as any).close = () => closeCalls.push(Date.now());

        realtimeSocket.websocket.open(ws);

        stopRealtimeSocketServer();

        expect(closeCalls).toHaveLength(1);
    });
});
