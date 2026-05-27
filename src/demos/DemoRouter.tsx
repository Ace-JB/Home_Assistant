import type { ReactNode } from 'react';
import { DemoIndex } from './DemoIndex';
import { AudioASRDemo } from '../modules/audio-asr';
import { VideoRecognitionDemo } from '../modules/video-recognition';

export function DemoRouter({ children }: { children: ReactNode }) {
  const pathname = window.location.pathname;

  if (pathname === '/demo') {
    return <DemoIndex />;
  }

  if (pathname === '/demo/video') {
    return <VideoRecognitionDemo />;
  }

  if (pathname === '/demo/audio') {
    return <AudioASRDemo />;
  }

  return <>{children}</>;
}
