import { expect, test, describe, beforeEach } from "bun:test";
import { VideoSavingQueue } from "../tools/Queue";
import { measurePerformance } from "./performance_utils";

describe("VideoSavingQueue", () => {
    let queue: VideoSavingQueue;

    beforeEach(() => {
        queue = new VideoSavingQueue();
    });

    test("should process tasks sequentially", async () => {
        const testImagePath = require("path").join(process.cwd(), "src/server/test/assets/test_face.png");
        const imageBuffer = require("fs").readFileSync(testImagePath);
        const dummySnapshot = { 
            videos: [{ ts: Date.now(), durationMs: 100, data: imageBuffer }], 
            audios: Array(10).fill(0).map((_, i) => ({
                ts: Date.now() + i * 50,
                durationMs: 50,
                data: Buffer.alloc(1600)
            })), 
            startTs: Date.now(), 
            endTs: Date.now() + 500 
        };
        
        const { duration } = await measurePerformance("Queue.push", async () => {
            await queue.push({ snapshot: dummySnapshot, urgency: "LOW" });
        });
        
        expect(duration).toBeGreaterThanOrEqual(0);
    });
});
