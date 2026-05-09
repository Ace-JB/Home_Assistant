import { expect, test, describe } from "bun:test";
import { safeSave } from "../tools/Async_Voice_Video";
import { measurePerformance } from "./performance_utils";
import { readFileSync } from "fs";
import path from "path";

describe("Media Save Performance", () => {
    test("should save a small snapshot as MP4 and measure performance", async () => {
        const testImagePath = path.join(process.cwd(), "src/server/test/assets/test_face.png");
        const imageBuffer = readFileSync(testImagePath);
        
        // Create a dummy snapshot with 5 identical frames
        const snapshot = {
            videos: Array(5).fill(0).map((_, i) => ({
                ts: Date.now() + i * 100,
                durationMs: 100,
                data: imageBuffer
            })),
            audios: Array(10).fill(0).map((_, i) => ({
                ts: Date.now() + i * 50,
                durationMs: 50,
                data: Buffer.alloc(1600) // Small silent PCM buffer
            })),
            startTs: Date.now(),
            endTs: Date.now() + 500
        };

        const { result, duration } = await measurePerformance("Async_Voice_Video.safeSave", async () => {
            await safeSave(snapshot, "TEST");
        });

        expect(duration).toBeGreaterThan(0);
    });
});
