import { expect, test, describe } from "bun:test";
import { calculatePcmLevel } from "../tools/Socket";
import { measurePerformance } from "./performance_utils";

describe("Socket Utils", () => {
    test("should calculate PCM level and measure performance", async () => {
        const audio = Buffer.alloc(16000 * 2); // 1 second of silence
        for (let i = 0; i < audio.length; i += 2) {
            audio.writeInt16LE(Math.floor(Math.random() * 32767), i);
        }

        const { result, duration } = await measurePerformance("Socket.calculatePcmLevel", async () => {
            return calculatePcmLevel(audio);
        });

        expect(result.rms).toBeGreaterThan(0);
        expect(result.peak).toBeGreaterThan(0);
    });
});
