import { describe, expect, test } from "bun:test";
import { buildHotspots, generateHtml, parseOutput } from "./generate_report";

const SAMPLE_OUTPUT = `
(pass) SyncManager > should add video frames and retrieve snapshot [0.60ms]
[Performance] SyncManager.addVideo took 0.31ms
(pass) FaceEngine Performance > should recognize faces and measure performance [48.99ms]
[Performance] FaceEngine.recognizeFaces took 48.60ms
(pass) Socket Utils > should calculate PCM level and measure performance [3.50ms]
[Performance] Socket.calculatePcmLevel took 1.56ms
Ran 3 tests across 3 files. [0.75s]
`;

describe("Report Generation", () => {
    test("should parse Bun test output and performance metrics", () => {
        const data = parseOutput(SAMPLE_OUTPUT);

        expect(data.summary.total).toBe(3);
        expect(data.summary.pass).toBe(3);
        expect(data.summary.fail).toBe(0);
        expect(data.summary.time).toBe("0.75s");
        expect(data.performanceMetrics.length).toBe(3);
        expect(data.performanceMetrics[1]!.category).toBe("face-inference");
    });

    test("should rank hotspots by duration and compare baselines", () => {
        const data = parseOutput(SAMPLE_OUTPUT);
        const hotspots = buildHotspots(data.performanceMetrics, {
            performanceMetrics: [
                { name: "FaceEngine.recognizeFaces", duration: 50 },
                { name: "Socket.calculatePcmLevel", duration: 1 },
            ],
        });

        expect(hotspots[0]!.name).toBe("FaceEngine.recognizeFaces");
        expect(hotspots[0]!.rank).toBe(1);
        expect(hotspots[0]!.delta).toBeCloseTo(-1.4, 1);
        expect(hotspots[1]!.delta).toBeCloseTo(0.56, 2);
    });

    test("should generate a report with hotspot and test sections", () => {
        const html = generateHtml(parseOutput(SAMPLE_OUTPUT));

        expect(html).toContain("Performance Hotspots");
        expect(html).toContain("Algorithm Candidates");
        expect(html).toContain("Test Results");
        expect(html).toContain("FaceEngine.recognizeFaces");
    });
});
