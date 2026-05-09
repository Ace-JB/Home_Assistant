import { GLOBAL_CONFIG } from '@/global_config';
import { initCamera } from "./tools/Camera";
import { extractTextFromVoiceStream, initAudioListen } from "./tools/Voice";
import { realtimeSocket, startRealtimeSocketServer, calculatePcmLevel } from "./tools/Socket";

import Pipe2Jpeg from 'pipe2jpeg';
import { syncManager } from './modules/media';

const SUBTITLE_VAD_THRESHOLD = 0.05; // 过滤背景低频噪点
const MAX_SUBTITLE_DURATION_MS = 10000; // 单次录音最长 10 秒
const SILENCE_END_MS = 800; // 连续静音 800ms 认为说话结束

let firstAudioReceived = false;

async function monitor() {
    startRealtimeSocketServer();

    const [{ stream: video, stop: stopVideo }, { stream: audio, stop: stopAudio }] = await Promise.all([
        initCamera(),
        initAudioListen(),
    ]);

    const p2j = new Pipe2Jpeg();
    video.pipe(p2j);

    let subtitleBuffer: Buffer[] = [];
    let subtitleBufferStartedAt = 0;
    let lastActiveTs = 0;
    let isSpeaking = false;
    let subtitleTranscribing = false;

    async function flushSubtitleBuffer() {
        if (subtitleTranscribing || subtitleBuffer.length === 0) {
            return;
        }

        const audioStartTs = subtitleBufferStartedAt;
        const audioEndTs = Date.now();
        const audioBuffer = Buffer.concat(subtitleBuffer);

        // 重置状态
        subtitleBuffer = [];
        subtitleBufferStartedAt = 0;
        lastActiveTs = 0;
        isSpeaking = false;

        subtitleTranscribing = true;
        try {
            const text = await extractTextFromVoiceStream(audioBuffer);
            if (text) {
                realtimeSocket.publishVoiceText(text, audioStartTs, audioEndTs);

                // --- 语音指令逻辑：唤醒词检测 ---
                const wakeWord = GLOBAL_CONFIG.VOICE.WAKE_WORD;
                if (text.includes(wakeWord)) {
                    console.log(`🎯 检测到唤醒词 [${wakeWord}], 正在处理指令...`);
                    const command = text.split(wakeWord).pop()?.trim();
                    if (command) {
                        const { brain } = await import('@/server/modules/brain');
                        const { speak } = await import('./tools/Voice');

                        const response = await brain.processCommand(command, "主人");
                        console.log(`🤖 AI 响应: ${response}`);
                        void speak(response);
                        realtimeSocket.publishVoiceText(`[AI] ${response}`, Date.now(), Date.now() + 2000);
                    }
                }
            }
        } catch (error) {
            console.error('Subtitle transcription failed:', error);
        } finally {
            subtitleTranscribing = false;
        }
    }

    p2j.on('data', (jpegBuffer: Buffer) => {
        syncManager.addVideo(jpegBuffer);
    });

    audio.on('data', (data: Buffer) => {
        if (!firstAudioReceived) {
            console.log('🎙️ Audio data flowing into monitor...');
            firstAudioReceived = true;
        }

        syncManager.addAudio(data);
        realtimeSocket.publishVoiceChunk(data);

        if (!realtimeSocket.isRealtimeSubtitleEnabled()) {
            subtitleBuffer = [];
            isSpeaking = false;
            return;
        }

        // 计算当前音频块的能量
        const { peak } = calculatePcmLevel(data);
        const now = Date.now();

        if (peak >= SUBTITLE_VAD_THRESHOLD) {
            // 检测到声音
            if (!isSpeaking) {
                isSpeaking = true;
                subtitleBufferStartedAt = now;
            }
            lastActiveTs = now;
            subtitleBuffer.push(data);
        } else {
            // 静音阶段
            if (isSpeaking) {
                subtitleBuffer.push(data);
                // 检查是否静音超过阈值 或者 录音时间过长
                const silenceDuration = now - lastActiveTs;
                const totalDuration = now - subtitleBufferStartedAt;

                if (silenceDuration > SILENCE_END_MS || totalDuration > MAX_SUBTITLE_DURATION_MS) {
                    void flushSubtitleBuffer();
                }
            }
        }
    });
}

export async function startMonitor() {
    console.log('🚀 Starting Sentinel Monitor (Camera & Audio)...');
    try {
        await monitor();
    } catch (error) {
        console.error('❌ Monitor failed to start:', error);
    }
}
