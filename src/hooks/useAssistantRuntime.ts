import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_ASSISTANT_RUNTIME_STATUS,
  isAssistantRuntimeAvailable,
  type AssistantRuntimeStartInput,
  type AssistantRuntimeStatus,
} from '../types/assistantRuntime';

type RuntimeAction = 'start' | 'stop';

export function useAssistantRuntime() {
  const [status, setStatus] = useState<AssistantRuntimeStatus>(DEFAULT_ASSISTANT_RUNTIME_STATUS);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<RuntimeAction | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/assistant-runtime/status', { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as AssistantRuntimeStatus;
      setStatus(data);
      setError('');
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === 'AbortError') return;
      setError(nextError instanceof Error ? nextError.message : 'Runtime status unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => {
      void refresh(controller.signal);
    }, 2000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const runAction = useCallback(async (action: RuntimeAction, input?: AssistantRuntimeStartInput) => {
    setBusyAction(action);
    try {
      const response = await fetch(`/api/assistant-runtime/${action}`, {
        method: 'POST',
        headers: action === 'start' ? { 'Content-Type': 'application/json' } : undefined,
        body: action === 'start' ? JSON.stringify(input ?? {}) : undefined,
      });
      const data = await response.json().catch(() => ({})) as AssistantRuntimeStatus & { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setStatus(data);
      setError('');
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Runtime action failed');
    } finally {
      setBusyAction(null);
    }
  }, [refresh]);

  return {
    status,
    loading,
    busyAction,
    error,
    available: isAssistantRuntimeAvailable(status),
    refresh,
    start: (input?: AssistantRuntimeStartInput) => runAction('start', input),
    stop: () => runAction('stop'),
  };
}
