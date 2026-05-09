import { GLOBAL_CONFIG } from '@/global_config';
import { initCamera } from "@tools/Camera";
import { extractTextFromVoiceStream, initAudioListen } from "@tools/Voice";
import { realtimeSocket, startRealtimeSocketServer, calculatePcmLevel } from "@tools/Socket";

import Pipe2Jpeg from 'pipe2jpeg';
import { syncManager } from '@modules/media';

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
    let systemSpeaking = false; // 新增：系统是否正在说话
    let subtitleTranscribing = false;
    let isAwake = false;
    let wakeTimer: any = null;

    async function flushSubtitleBuffer() {
        if (subtitleTranscribing || subtitleBuffer.length === 0 || systemSpeaking) {
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

                // --- 语音指令逻辑：唤醒词 & 会话状态检测 ---
                const wakeWord = GLOBAL_CONFIG.VOICE.WAKE_WORD;
                const hasWakeWord = text.includes(wakeWord);

                if (hasWakeWord || isAwake) {
                    // 如果包含唤醒词，进入唤醒状态并开启/重置计时器
                    if (hasWakeWord) {
                        console.log(`🎯 检测到唤醒词 [${wakeWord}], 进入指令监听模式...`);
                        isAwake = true;
                    }

                    // 核心修复：只要检测到可能是指令，立即清除旧的倒计时，防止在思考/说话期间超时
                    if (wakeTimer) {
                        clearTimeout(wakeTimer);
                        wakeTimer = null;
                    }

                    let command = hasWakeWord ? text.split(wakeWord).pop()?.trim() : text;

                    if (command && command.length > 1) {
                        console.log(`🧠 正在执行指令: "${command}"`);
                        const { brain } = await import('@server/modules/brain');
                        const { speak } = await import('@tools/Voice');

                        const response = await brain.processCommand(command, "主人");
                        console.log(`🤖 AI 响应: ${response}`);

                        // 在说话期间停止监听，防止自唤醒循环
                        systemSpeaking = true;
                        try {
                            await speak(response);
                        } finally {
                            systemSpeaking = false;
                            // 说话结束后稍微延迟一点再恢复，给环境音留出消散时间
                            await new Promise(r => setTimeout(r, 800));

                            // 说话结束后重置唤醒倒计时，提供 15s 追问时间
                            if (wakeTimer) clearTimeout(wakeTimer);
                            wakeTimer = setTimeout(() => {
                                isAwake = false;
                                console.log("💤 会话超时，回到待机状态");
                            }, 15000);
                        }

                        realtimeSocket.publishVoiceText(`[AI] ${response}`, Date.now(), Date.now() + 2000);
                    } else if (hasWakeWord) {
                        // 如果只有唤醒词而没有后续指令，启动基础超时计时
                        wakeTimer = setTimeout(() => {
                            isAwake = false;
                            console.log("💤 指令监听超时，回到待机状态");
                        }, 15000);
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
        if (systemSpeaking) return; // 系统说话时直接丢弃音频块
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
