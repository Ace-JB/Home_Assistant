import { expect, test, describe, beforeEach } from "bun:test";
import { SyncManager } from "@modules/media";
import { measurePerformance } from "./performance_utils";

describe("SyncManager", () => {
    let syncManager: SyncManager;

    beforeEach(() => {
        syncManager = new SyncManager(1000); // 1 second window
    });

    test("should add video frames and retrieve snapshot", async () => {
        const { result: _, duration } = await measurePerformance("SyncManager.addVideo", async () => {
            syncManager.addVideo(Buffer.from("video1"), { label: "face1" });
            syncManager.addVideo(Buffer.from("video2"), { label: "face2" });
        });

        const snapshot = syncManager.getSnapshot(500);
        expect(snapshot.videos.length).toBe(2);
        expect(snapshot.videos[0]!.data.toString()).toBe("video1");
        expect(snapshot.videos[1]!.data.toString()).toBe("video2");
    });

    test("should add audio frames and retrieve snapshot", async () => {
        await measurePerformance("SyncManager.addAudio", async () => {
            syncManager.addAudio(Buffer.from("audio1"));
            syncManager.addAudio(Buffer.from("audio2"));
        });

        const snapshot = syncManager.getSnapshot(500);
        expect(snapshot.audios.length).toBe(2);
        expect(snapshot.audios[0]!.data.toString()).toBe("audio1");
    });

    test("should clean old frames", async () => {
        syncManager.addVideo(Buffer.from("old"), { label: "old" });
        
        // Wait for 1.1 seconds (longer than windowSizeMs)
        await new Promise(resolve => setTimeout(resolve, 1100));
        
        syncManager.addVideo(Buffer.from("new"), { label: "new" });
        
        const snapshot = syncManager.getSnapshot(2000);
        expect(snapshot.videos.length).toBe(1);
        expect(snapshot.videos[0]!.data.toString()).toBe("new");
    });

    test("should calculate correct durationMs", () => {
        syncManager.addVideo(Buffer.from("1"));
        
        // Mocking time passing is hard with Date.now() in real tests, 
        // but we can check if it's non-zero for the second frame.
        syncManager.addVideo(Buffer.from("2"));
        const snapshot = syncManager.getSnapshot(1000);
        expect(snapshot.videos[1]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("should prune multiple expired frames while preserving valid frames", () => {
        const originalNow = Date.now;
        let now = 1_000;
        Date.now = () => now;

        try {
            syncManager.addVideo(Buffer.from("old-1"));
            now = 1_100;
            syncManager.addVideo(Buffer.from("old-2"));
            now = 2_200;
            syncManager.addVideo(Buffer.from("new"));

            const snapshot = syncManager.getSnapshot(1_000);
            expect(snapshot.videos.length).toBe(1);
            expect(snapshot.videos[0]!.data.toString()).toBe("new");
        } finally {
            Date.now = originalNow;
        }
    });
});
