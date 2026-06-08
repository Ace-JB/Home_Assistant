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
        const { result, duration } = await measurePerformance("FaceEngine.detectAll.faces", async () => {
            return (await faceEngine.detectAll(buffer)).faces;
        });

        expect(result.length).toBeGreaterThan(0);
        expect(result[0]!.matched).toBeBoolean();
        expect(result[0]!.threshold).toBeGreaterThan(0);
        console.log(`[FaceEngine] Found ${result.length} faces`);
        result.forEach(face => {
            console.log(`[FaceEngine] Detected: ${face.label} candidate=${face.candidateLabel ?? '-'} similarity=${face.similarity ?? '-'} at [${face.box.x}, ${face.box.y}]`);
        });
    });

    test("should run identity profile without perception outputs", async () => {
        const buffer = readFileSync(testImagePath);
        const result = await faceEngine.detect(buffer, "identity");

        expect(result.profile).toBe("identity");
        expect(result.requestedProfile).toBe("identity");
        expect(result.degraded).toBe(false);
        expect(result.faces.length).toBeGreaterThan(0);
        expect(result.bodies).toHaveLength(0);
        expect(result.hands).toHaveLength(0);
        expect(result.objects).toHaveLength(0);
    });

    test("should expose profile metadata for full detection", async () => {
        const buffer = readFileSync(testImagePath);
        const result = await faceEngine.detect(buffer, "full");

        expect(result.profile).toBe("full");
        expect(result.requestedProfile).toBe("full");
        expect(result.degraded).toBe(false);
        expect(result.faces.length).toBeGreaterThan(0);
    });

    test("should not cleanup identity profile", () => {
        const resetCalls: string[] = [];
        faceEngine.__setEngineForTest("identity", {
            human: { models: { reset: () => resetCalls.push("identity") } } as any,
            lastUsedAt: 1000,
        });

        const result = faceEngine.cleanupIdleProfiles({
            now: 10_000,
            idleTtlMs: 1000,
            activeProfile: "identity",
            hasActiveRequest: false,
        });

        expect(result.find((item) => item.profile === "identity")?.reason).toBe("identity");
        expect(resetCalls).toHaveLength(0);
        expect(faceEngine.__hasEngineForTest("identity")).toBe(true);
    });

    test("should not cleanup running or loading high profiles", () => {
        const resetCalls: string[] = [];
        faceEngine.__setEngineForTest("perception", {
            human: { models: { reset: () => resetCalls.push("perception") } } as any,
            lastUsedAt: 1000,
            runningCount: 1,
        });
        faceEngine.__setEngineForTest("full", {
            human: { models: { reset: () => resetCalls.push("full") } } as any,
            lastUsedAt: 1000,
            loadPromise: new Promise(() => undefined),
        });

        const result = faceEngine.cleanupIdleProfiles({
            now: 10_000,
            idleTtlMs: 1000,
            activeProfile: "identity",
            hasActiveRequest: false,
        });

        expect(result.find((item) => item.profile === "perception")?.reason).toBe("running");
        expect(result.find((item) => item.profile === "full")?.reason).toBe("loading");
        expect(resetCalls).toHaveLength(0);
    });

    test("should cleanup idle perception and full profiles", () => {
        const resetCalls: string[] = [];
        faceEngine.__setEngineForTest("perception", {
            human: { models: { reset: () => resetCalls.push("perception") } } as any,
            lastUsedAt: 1000,
        });
        faceEngine.__setEngineForTest("full", {
            human: { models: { reset: () => resetCalls.push("full") } } as any,
            lastUsedAt: 2000,
        });

        const result = faceEngine.cleanupIdleProfiles({
            now: 10_000,
            idleTtlMs: 1000,
            activeProfile: "identity",
            hasActiveRequest: false,
        });

        expect(result.filter((item) => item.action === "released").map((item) => item.profile)).toEqual(["perception", "full"]);
        expect(resetCalls).toEqual(["perception", "full"]);
        expect(faceEngine.__hasEngineForTest("perception")).toBe(false);
        expect(faceEngine.__hasEngineForTest("full")).toBe(false);
    });

    test("should not cleanup while attention has active request", () => {
        const resetCalls: string[] = [];
        faceEngine.__setEngineForTest("full", {
            human: { models: { reset: () => resetCalls.push("full") } } as any,
            lastUsedAt: 1000,
        });

        const result = faceEngine.cleanupIdleProfiles({
            now: 10_000,
            idleTtlMs: 1000,
            activeProfile: "full",
            hasActiveRequest: true,
        });

        expect(result.find((item) => item.profile === "full")?.reason).toBe("active_request");
        expect(resetCalls).toHaveLength(0);
        expect(faceEngine.__hasEngineForTest("full")).toBe(true);
    });
});
