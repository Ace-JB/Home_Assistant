import { useEffect, useRef, useState } from 'react';
import type { RealtimeMessage, BufferedFrame, SubtitleCue, RealtimeState } from '../types/realtime';

export function useRealtimeFeedback(): RealtimeState {
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
    activeSubtitle: '',
    subtitleEnabled: false,
    videoDelayMs: 5000,
    lastFrameAt: null,
    visionDetection: null,
    setRealtimeSubtitle: () => {},
    setLanguage: () => {},
    setVideoDelay: () => {},
  });

  useEffect(() => {
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
            subtitleEnabled: message.realtimeSubtitleEnabled,
            language: message.language,
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
          subtitleCuesRef.current.push({
            startTs: message.startTs,
            endTs: message.endTs,
            text: message.text,
          });
          subtitleCuesRef.current = subtitleCuesRef.current.slice(-40);
          return { ...prev, transcript: message.text };
        }

        if (message.type === 'vision.detection') {
          return {
            ...prev,
            visionDetection: {
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
  }, []);

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
    setRealtimeSubtitle: (enabled: boolean) => {
      setState((prev) => ({ ...prev, subtitleEnabled: enabled }));
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current?.send(JSON.stringify({ type: 'subtitle.enable', enabled }));
      }
    },
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
