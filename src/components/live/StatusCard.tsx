import type { FC, ReactNode } from 'react';

export const StatusCard: FC<{
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  className?: string;
}> = ({ label, value, detail, className = '' }) => (
  <div className={`rounded-lg border border-slate-800 bg-slate-900/70 p-4 ${className}`}>
    <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
    <div className="mt-2 text-sm leading-6 text-slate-200">{value}</div>
    {detail ? <div className="mt-3 text-xs text-slate-500">{detail}</div> : null}
  </div>
);
