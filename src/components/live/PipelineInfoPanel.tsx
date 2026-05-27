import type { FC } from 'react';
import { useI18n } from '../../i18n';

export const PipelineInfoPanel: FC<{ className?: string }> = ({ className = '' }) => {
  const { t } = useI18n();

  return (
    <div className={`bg-slate-900 p-6 rounded-2xl border border-slate-800 ${className}`}>
      <div className="text-slate-500 uppercase mb-4">{t('live.pipelineParams')}</div>
      <div className="flex justify-between border-b border-slate-800 pb-2 mb-2">
        <span>{t('live.transport')}</span>
        <span className="text-white">WebRTC / RTP</span>
      </div>
      <div className="flex justify-between">
        <span>{t('live.encoder')}</span>
        <span className="text-white">VideoToolbox (H.264)</span>
      </div>
      <div className="flex justify-between border-t border-slate-800 pt-2 mt-2">
        <span>{t('live.aiBackend')}</span>
        <span className="text-white">TensorFlow Node</span>
      </div>
    </div>
  );
};
