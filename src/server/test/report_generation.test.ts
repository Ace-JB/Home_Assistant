import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import { buildHotspots, generateHtml, generateReadmeReport, parseOutput, syncReadme } from "./generate_report";

const SAMPLE_OUTPUT = `
(pass) SyncManager > should add video frames and retrieve snapshot [0.60ms]
[Performance] SyncManager.addVideo took 0.31ms
(pass) FaceEngine Performance > should recognize faces and measure performance [48.99ms]
[Performance] FaceEngine.recognizeFaces took 48.60ms
(pass) Socket Utils > should calculate PCM level and measure performance [3.50ms]
[Performance] Socket.calculatePcmLevel took 1.56ms
Ran 3 tests across 3 files. [0.75s]
12 expect() calls
`;

describe("Report Generation", () => {
    test("should parse Bun test output and performance metrics", () => {
        const data = parseOutput(SAMPLE_OUTPUT);

        expect(data.summary.total).toBe(3);
        expect(data.summary.pass).toBe(3);
        expect(data.summary.fail).toBe(0);
        expect(data.summary.time).toBe("0.75s");
        expect(data.summary.files).toBe(3);
        expect(data.summary.assertions).toBe(12);
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

    test("should generate a README report block", () => {
        const report = generateReadmeReport(parseOutput(SAMPLE_OUTPUT));

        expect(report).toContain("<!-- TEST_REPORT_START -->");
        expect(report).toContain("| **Socket** | `calculatePcmLevel` | **1.56 ms** | Audio volume analysis |");
        expect(report).toContain("Result: **3 pass / 0 fail / 12 assertions** across 3 files in **0.75s**.");
        expect(report).toContain("<!-- TEST_REPORT_END -->");
    });

    test("should sync the managed README report block", () => {
        const dir = mkdtempSync(join(tmpdir(), "ha-readme-"));
        const readmePath = join(dir, "README.md");

        try {
            writeFileSync(readmePath, [
                "# Home Assistant - Sentinel",
                "",
                "<!-- TEST_REPORT_START -->",
                "old report",
                "<!-- TEST_REPORT_END -->",
                "",
                "## Hardware & Environment",
                "- stable content",
            ].join("\n"));

            syncReadme(parseOutput(SAMPLE_OUTPUT), readmePath);

            const readme = readFileSync(readmePath, "utf8");
            expect(readme).not.toContain("old report");
            expect(readme).toContain("| **FaceEngine** | `recognizeFaces` | **48.60 ms** | Detection plus similarity-based identity check |");
            expect(readme).toContain("## Hardware & Environment");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
