import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createLogger, type Logger } from '../observability/logger';

interface ModuleErrorBoundaryProps {
  moduleName: string;
  children: ReactNode;
  fallback?: ReactNode;
  logger?: Logger;
}

interface ModuleErrorBoundaryState {
  error: Error | null;
}

export class ModuleErrorBoundary extends Component<ModuleErrorBoundaryProps, ModuleErrorBoundaryState> {
  override state: ModuleErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ModuleErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const logger = this.props.logger ?? createLogger(this.props.moduleName);
    logger.error('Module crashed', { error, componentStack: info.componentStack });
  }

  override render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <div className="rounded-lg border border-red-500/30 bg-red-950/40 p-4 text-sm text-red-100">
        <div className="font-semibold">{this.props.moduleName} failed</div>
        <div className="mt-1 text-red-200/80">{this.state.error.message}</div>
      </div>
    );
  }
}
