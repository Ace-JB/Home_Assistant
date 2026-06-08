import React, { useEffect, useRef } from 'react';
import { setupWebRTC } from '@/webrtc_client';

/**
 * Sentinel Monitor Component.
 * WebRTC provides the camera preview; backend vision.detection is rendered by
 * HumanPerceptionPanel so the browser does not run a duplicate Human.js model.
 */
export const SentinelMonitor: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!videoRef.current) return;

    const video = videoRef.current;
    const cleanupRTC = setupWebRTC(video);

    return () => {
      cleanupRTC();
    };
  }, []);

  return (
    <div className="relative overflow-hidden rounded-2xl bg-[#1e293b] shadow-2xl border-4 border-[#6B4423]/20" 
         style={{ width: '640px', height: '480px' }}>
      
      {/* 视频层 */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* 底部渐变遮罩 */}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/40 to-transparent pointer-events-none" />
    </div>
  );
};

export default SentinelMonitor;
