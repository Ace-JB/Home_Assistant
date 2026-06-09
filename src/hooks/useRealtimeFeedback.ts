import { useEffect, useRef, useState } from 'react';
import type { RealtimeMessage, BufferedFrame, SubtitleCue, RealtimeState, TranscriptEntry } from '../types/realtime';

export function useRealtimeFeedback(enabled = true): RealtimeState {
  const socketRef = useRef<WebSocket | null>(null);
  const frameQueueRef = useRef<BufferedFrame[]>([]);
  const subtitleCuesRef = useRef<SubtitleCue[]>([]);
  const [state, setState] = useState<RealtimeState>({
    connected: false,
    clients: 0,
    language: 'zh',
    frameSrc: null,
    audioLevel: 0,
    transcript: '',
    transcriptHistory: [],
    activeSubtitle: '',
    voiceSessionMode: 'standby',
    videoDelayMs: 5000,
    lastFrameAt: null,
    visionDetection: null,
    setLanguage: () => {},
    setVideoDelay: () => {},
  });

  useEffect(() => {
    if (!enabled) {
      socketRef.current?.close();
      socketRef.current = null;
      frameQueueRef.current = [];
      subtitleCuesRef.current = [];
      setState((prev) => ({
        ...prev,
        connected: false,
        clients: 0,
        frameSrc: null,
        audioLevel: 0,
        transcript: '',
        activeSubtitle: '',
        voiceSessionMode: 'standby',
        lastFrameAt: null,
        visionDetection: null,
      }));
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const currentPort = Number(window.location.port || (window.location.protocol === 'https:' ? 443 : 80));
    const socketHost = `${window.location.hostname}:${currentPort + 1}`;
    const socket = new WebSocket(`${protocol}//${socketHost}/ws/realtime`);
    socketRef.current = socket;

    socket.addEventListener('open', () => {
      setState((prev) => ({ ...prev, connected: true }));
    });

    socket.addEventListener('close', () => {
      setState((prev) => ({ ...prev, connected: false }));
    });

    socket.addEventListener('message', (event) => {
      let message: RealtimeMessage;

      try {
        message = JSON.parse(event.data) as RealtimeMessage;
      } catch {
        return;
      }

      setState((prev) => {
        if (message.type === 'socket.connected' || message.type === 'socket.status') {
          return {
            ...prev,
            connected: true,
            clients: message.clients,
            language: message.language,
            voiceSessionMode: message.voiceSessionMode,
          };
        }

        if (message.type === 'video.frame') {
          // Camera preview is transported exclusively through WebRTC.
          // Do not enqueue JPEG frames on this realtime socket.
          return prev;
        }

        if (message.type === 'voice.level') {
          return {
            ...prev,
            audioLevel: Math.min(100, Math.round(message.rms * 500)),
          };
        }

        if (message.type === 'voice.text') {
          const entry: TranscriptEntry = {
            startTs: message.startTs,
            endTs: message.endTs,
            text: message.text,
            ts: message.ts,
          };
          subtitleCuesRef.current.push({
            startTs: message.startTs,
            endTs: message.endTs,
            text: message.text,
          });
          subtitleCuesRef.current = subtitleCuesRef.current.slice(-40);
          return {
            ...prev,
            transcript: message.text,
            transcriptHistory: [...prev.transcriptHistory, entry].slice(-20),
          };
        }

        if (message.type === 'voice.session') {
          return {
            ...prev,
            voiceSessionMode: message.mode,
          };
        }

        if (message.type === 'vision.detection') {
          return {
            ...prev,
            visionDetection: {
              profile: message.profile,
              requestedProfile: message.requestedProfile,
              degraded: message.degraded,
              ...(message.degradeReason ? { degradeReason: message.degradeReason } : {}),
              faces: message.faces,
              bodies: message.bodies,
              hands: message.hands,
              objects: message.objects,
              ts: message.ts,
            },
          };
        }

        return prev;
      });
    });

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [enabled]);

  useEffect(() => {
    const timer = setInterval(() => {
      setState((prev) => {
        const playbackTs = Date.now() - prev.videoDelayMs;
        let frameSrc = prev.frameSrc;
        let lastFrameAt = prev.lastFrameAt;

        while (frameQueueRef.current.length > 0 && frameQueueRef.current[0]!.ts <= playbackTs) {
          const frame = frameQueueRef.current.shift()!;
          frameSrc = frame.src;
          lastFrameAt = frame.ts;
        }

        frameQueueRef.current = frameQueueRef.current.filter((frame) => frame.ts >= playbackTs - 2000);
        subtitleCuesRef.current = subtitleCuesRef.current.filter((cue) => cue.endTs >= playbackTs - 5000);

        const activeCue = subtitleCuesRef.current.find((cue) => (
          cue.startTs <= playbackTs && playbackTs <= cue.endTs + 2500
        ));

        return {
          ...prev,
          frameSrc,
          lastFrameAt,
          activeSubtitle: activeCue?.text ?? '',
        };
      });
    }, 50);

    return () => clearInterval(timer);
  }, []);

  return {
    ...state,
    setLanguage: (language: 'zh' | 'en') => {
      setState((prev) => ({ ...prev, language }));
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current?.send(JSON.stringify({ type: 'language.set', language }));
      }
    },
    setVideoDelay: (delayMs: number) => {
      frameQueueRef.current = [];
      setState((prev) => ({
        ...prev,
        videoDelayMs: delayMs,
        activeSubtitle: '',
      }));
    },
  };
}
