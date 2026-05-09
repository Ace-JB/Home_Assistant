import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from "werift";
import { type ServerWebSocket } from "bun";
import { GLOBAL_CONFIG } from "@/global_config";
import { createSocket } from "dgram";

/**
 * WebRTC Signaling & Streaming Module for Apple Silicon (Bun + Werift)
 */
export class WebRTCManager {
    private pc: RTCPeerConnection | null = null;
    private videoTrack = new MediaStreamTrack({ kind: "video" });
    private ffmpegProcess: any = null;
    private udpServer = createSocket("udp4");
    private rtpPort = Math.floor(Math.random() * 10000) + 10000;

    constructor() {
        this.setupUdpReceiver();
    }

    /**
     * 设置 UDP 接收器，将 FFmpeg 的 RTP 数据转发给 Werift Track
     */
    private setupUdpReceiver() {
        this.udpServer.on("message", (msg) => {
            // 将接收到的 RTP 包直接喂给 Werift 的 VideoTrack
            this.videoTrack.writeRtp(msg);
        });

        this.udpServer.bind(this.rtpPort, "127.0.0.1", () => {
            console.log(`📡 WebRTC UDP Receiver listening on 127.0.0.1:${this.rtpPort}`);
        });
    }

    /**
     * 启动 FFmpeg 捕获本地摄像头并进行 H.264 硬件加速转码 (Apple Silicon 优化)
     */
    private startFFmpeg() {
        if (this.ffmpegProcess) return;

        const fps = GLOBAL_CONFIG.VIDEO.FPS;
        const width = GLOBAL_CONFIG.VIDEO.WIDTH;
        const height = GLOBAL_CONFIG.VIDEO.HEIGHT;
        const device = GLOBAL_CONFIG.VIDEO.DEVICE;

        console.log(`🎬 Starting FFmpeg capture from device ${device}...`);

        this.ffmpegProcess = Bun.spawn([
            GLOBAL_CONFIG.FFMPEG.BIN,
            "-hide_banner",
            "-loglevel", "warning",
            "-f", "avfoundation",
            "-framerate", fps,
            "-video_size", `${width}x${height}`,
            "-i", device,
            "-c:v", "h264_videotoolbox", // Apple Silicon 硬件加速编码器
            "-b:v", "1000k",             // 码率设置
            "-preset", "realtime",
            "-tune", "zerolatency",       // 零延迟优化
            "-pix_fmt", "yuv420p",
            "-f", "rtp",
            `rtp://127.0.0.1:${this.rtpPort}`
        ], {
            stdout: "inherit",
            stderr: "inherit",
        });
    }

    private candidateQueue: any[] = [];
    private isRemoteDescriptionSet = false;

    /**
     * 处理 WebRTC 信令
     */
    public async handleSignaling(ws: ServerWebSocket<any>, message: string) {
        try {
            const data = JSON.parse(message);
            console.log(`📩 WebRTC Signaling Message: ${data.type}`);

            if (data.type === "offer") {
                console.log("🤝 Processing WebRTC Offer...");

                const pc = new RTCPeerConnection({
                    codecs: {
                        video: [
                            new RTCRtpCodecParameters({
                                mimeType: "video/H264",
                                clockRate: 90000,
                                payloadType: 96,
                            }),
                        ],
                    },
                });

                this.pc = pc;

                pc.addTrack(this.videoTrack);

                pc.onIceCandidate.subscribe((candidate) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        // 过滤掉不完整的候选，防止前端报错
                        if (candidate && candidate.candidate && (candidate.sdpMid || candidate.sdpMLineIndex !== null)) {
                            ws.send(JSON.stringify({ type: "candidate", candidate }));
                        }
                    }
                });

                await pc.setRemoteDescription(data);
                const answer = await pc.createAnswer();

                // 再次检查 pc 是否还在，防止 await 期间连接已关闭
                if (this.pc !== pc) return;

                await pc.setLocalDescription(answer);

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: "answer",
                        sdp: pc.localDescription?.sdp
                    }));
                }

                this.isRemoteDescriptionSet = true;
                this.startFFmpeg();

                // 处理之前排队的候选
                while (this.candidateQueue.length > 0) {
                    const cand = this.candidateQueue.shift();
                    if (this.pc === pc) {
                        await pc.addIceCandidate(cand);
                    }
                }

                pc.iceConnectionStateChange.subscribe((state) => {
                    console.log(`🧊 ICE State: ${state}`);
                    if (state === "disconnected" || state === "closed") {
                        if (this.pc === pc) this.stop();
                    }
                });
            } else if (data.type === "candidate" && this.pc) {
                if (this.isRemoteDescriptionSet) {
                    console.log("🧊 Adding Client ICE Candidate");
                    await this.pc.addIceCandidate(data.candidate);
                } else {
                    console.log("🧊 Queueing Client ICE Candidate");
                    this.candidateQueue.push(data.candidate);
                }
            }
        } catch (error) {
            console.error("❌ WebRTC Signaling Error:", error);
            ws.close();
        }
    }

    public stop() {
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill();
            this.ffmpegProcess = null;
        }
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }
        console.log("🛑 WebRTC Stream Stopped");
    }
}

/**
 * 启动信令服务器 (基于 Bun.serve)
 */
export function startWebRTCSignalingServer(port: number = 3002) {
    const manager = new WebRTCManager();

    Bun.serve({
        port,
        fetch(req, server) {
            if (server.upgrade(req)) return;
            return new Response("WebRTC Signaling Server Ready");
        },
        websocket: {
            async message(ws, message) {
                if (typeof message === "string") {
                    await manager.handleSignaling(ws, message);
                }
            },
            close(ws) {
                manager.stop();
            }
        }
    });

    console.log(`🚀 WebRTC Signaling Server running on ws://localhost:${port}`);
}
