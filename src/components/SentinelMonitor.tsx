import React, { useEffect, useRef } from 'react';
import { setupWebRTC } from '@/webrtc_client';
import { HumanScheduler } from '@/human_scheduler';
import { HumanRenderer } from '@/human_renderer';

/**
 * Sentinel Monitor Component
 * Combines WebRTC stream, AI Worker, and MCM Renderer.
 */
export const SentinelMonitor: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const renderer = new HumanRenderer(canvas);

    // 1. 启动 WebRTC 接收端
    const cleanupRTC = setupWebRTC(video);

    // 2. 启动 AI 调度器 (Web Worker)
    const scheduler = new HumanScheduler(video, (result) => {
      // 3. 动态同步 Canvas 尺寸并绘制结果
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      renderer.draw(result);
    });

    return () => {
      cleanupRTC();
      scheduler.stop();
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

      {/* AI 渲染层 (Canvas Overlay) */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />

      {/* UI 装饰：中世纪现代主义标签 */}
      {/* <div className="absolute top-6 left-6 px-4 py-2 bg-[#F5F5F5] rounded-full shadow-lg border border-[#6B4423]/10">
        <span className="text-[#6B4423] font-semibold tracking-wider text-xs uppercase">
          Sentinel Monitoring
        </span>
      </div> */}
      
      {/* 底部渐变遮罩 */}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/40 to-transparent pointer-events-none" />
    </div>
  );
};

export default SentinelMonitor;
