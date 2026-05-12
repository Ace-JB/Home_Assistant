import { expect, test, describe, beforeAll } from "bun:test";
import { faceEngine } from "@modules/media/face";
import { measurePerformance } from "./performance_utils";
import { readFileSync } from "fs";
import path from "path";

describe("FaceEngine Performance", () => {
    const testImagePath = path.join(process.cwd(), "src/server/test/assets/test_face.png");

    beforeAll(async () => {
        // Measure model loading time
        await measurePerformance("FaceEngine.loadModels", async () => {
            await faceEngine.loadModels();
        });
    });

    test("should extract descriptor and measure performance", async () => {
        const { result, duration } = await measurePerformance("FaceEngine.extractDescriptor", async () => {
            return await faceEngine.extractDescriptor(testImagePath);
        });
        
        expect(result).not.toBeNull();
        expect(result instanceof Float32Array).toBe(true);
    });

    test("should recognize faces and measure performance", async () => {
        const buffer = readFileSync(testImagePath);
        const { result, duration } = await measurePerformance("FaceEngine.recognizeFaces", async () => {
            return await faceEngine.recognizeFaces(buffer);
        });

        expect(result.length).toBeGreaterThan(0);
        expect(result[0]!.matched).toBeBoolean();
        expect(result[0]!.threshold).toBeGreaterThan(0);
        console.log(`[FaceEngine] Found ${result.length} faces`);
        result.forEach(face => {
            console.log(`[FaceEngine] Detected: ${face.label} candidate=${face.candidateLabel ?? '-'} similarity=${face.similarity ?? '-'} at [${face.box.x}, ${face.box.y}]`);
        });
    });
});
