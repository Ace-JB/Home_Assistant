/**
 * WebRTC Client for Home Assistant Sentinel
 * Handles signaling and stream reception from Bun backend.
 */

export function setupWebRTC(videoElement: HTMLVideoElement, signalingUrl: string = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/webrtc`) {
    let pc: RTCPeerConnection | null = null;
    let ws: WebSocket | null = null;
    let reconnectTimeout: any = null;

    const candidateQueue: RTCIceCandidateInit[] = [];
    let isRemoteDescriptionSet = false;

    const connect = () => {
        console.log("📡 Connecting to WebRTC Signaling Server...");
        
        ws = new WebSocket(signalingUrl);

        ws.onopen = async () => {
            console.log("✅ Signaling WebSocket connected");
            initializePeerConnection();
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            
            if (data.type === "answer") {
                console.log("🤝 Received WebRTC Answer");
                if (pc) {
                    await pc.setRemoteDescription(new RTCSessionDescription(data));
                    isRemoteDescriptionSet = true;
                    // 处理排队的候选
                    while (candidateQueue.length > 0) {
                        const candidate = candidateQueue.shift()!;
                        await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    }
                }
            } else if (data.type === "candidate") {
                console.log("🧊 Received Remote ICE Candidate");
                if (pc && data.candidate) {
                    // 只有当 sdpMid 或 sdpMLineIndex 存在时才是有效的候选
                    if (data.candidate.candidate === "") {
                        console.log("🧊 End of candidates");
                        return;
                    }
                    
                    if (isRemoteDescriptionSet) {
                        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                    } else {
                        candidateQueue.push(data.candidate);
                    }
                }
            }
        };

        ws.onclose = () => {
            console.warn("🛑 Signaling WebSocket closed. Reconnecting in 3s...");
            cleanup();
            reconnectTimeout = setTimeout(connect, 3000);
        };

        ws.onerror = (err) => {
            console.error("❌ Signaling WebSocket error:", err);
            ws?.close();
        };
    };

    const initializePeerConnection = async () => {
        pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });

        // 监听远程轨道
        pc.ontrack = (event) => {
            console.log("📺 Received Remote Track");
            if (videoElement.srcObject !== event.streams[0]) {
                videoElement.srcObject = event.streams[0];
            }
        };

        // 监听 ICE 候选并发送给后端 (如果后端支持)
        pc.onicecandidate = (event) => {
            if (event.candidate && ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "candidate",
                    candidate: event.candidate
                }));
            }
        };

        // 强制接收视频
        pc.addTransceiver("video", { direction: "recvonly" });

        // 创建 Offer 并发送
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        console.log("📤 Sending WebRTC Offer");
        ws?.send(JSON.stringify({
            type: "offer",
            sdp: offer.sdp
        }));

        pc.oniceconnectionstatechange = () => {
            console.log(`🧊 ICE Connection State: ${pc?.iceConnectionState}`);
            if (pc?.iceConnectionState === "failed") {
                ws?.close();
            }
        };
    };

    const cleanup = () => {
        if (pc) {
            pc.close();
            pc = null;
        }
        if (videoElement) {
            videoElement.srcObject = null;
        }
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
        }
        // 重置连接状态，防止重连时使用旧状态导致 addIceCandidate 报错
        isRemoteDescriptionSet = false;
        candidateQueue.length = 0;
    };

    // 启动连接
    connect();

    // 返回清理函数
    return cleanup;
}
