import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { categorizePerformanceMetric, type PerformanceCategory } from "./performance_utils";

export interface TestResult {
    name: string;
    status: "pass" | "fail";
    duration?: number;
}

export interface ParsedPerformanceMetric {
    name: string;
    duration: number;
    category: PerformanceCategory;
}

export interface TestSummary {
    pass: number;
    fail: number;
    total: number;
    time: string;
    files: number;
    assertions: number;
}

export interface ParsedReportData {
    tests: TestResult[];
    performanceMetrics: ParsedPerformanceMetric[];
    summary: TestSummary;
}

export interface PerformanceHotspot extends ParsedPerformanceMetric {
    rank: number;
    baselineDuration?: number;
    delta?: number;
    deltaPercent?: number;
}

interface BaselineData {
    performanceMetrics?: Array<{ name: string; duration: number }>;
}

const ALGORITHM_CANDIDATES = [
    "SyncManager.cleanOld: prune expired frames in batches instead of repeated front-array deletion.",
    "FaceEngine matching: centralize best-match selection and prepare descriptor caching/vectorized distance checks if records grow.",
    "calculatePcmLevel: keep the linear scan, then benchmark larger PCM buffers before considering typed-array alternatives.",
];

const README_REPORT_START = "<!-- TEST_REPORT_START -->";
const README_REPORT_END = "<!-- TEST_REPORT_END -->";

const PERFORMANCE_NOTES: Record<string, string> = {
    "FaceEngine.loadModels": "One-time startup / warmup",
    "FaceEngine.extractDescriptor": "Per-face feature extraction",
    "FaceEngine.recognizeFaces": "Detection plus similarity-based identity check",
    "SyncManager.addVideo": "Frame push overhead",
    "SyncManager.addAudio": "Audio buffer push overhead",
    "SyncManager.cleanOld": "Batched expiry cleanup",
    "Socket.calculatePcmLevel": "Audio volume analysis",
    "Async_Voice_Video.safeSave": "Optimized MP4 synthesis",
    "VoiceUtils.normalize": "Text cleanup & VAD filtering",
    "Queue.push": "Sequential task queue overhead",
};

export async function runTests() {
    console.log("Running tests and generating report...");

    const bunTest = spawn("bun", ["test", "./src/server/test/"], {
        env: { ...process.env, FORCE_COLOR: "0" }
    });

    let output = "";
    bunTest.stdout.on("data", (data) => {
        output += data.toString();
        process.stdout.write(data);
    });

    bunTest.stderr.on("data", (data) => {
        output += data.toString();
        process.stderr.write(data);
    });

    return new Promise<{ output: string; code: number | null }>((resolve) => {
        bunTest.on("close", (code) => {
            resolve({ output, code });
        });
    });
}

export function parseOutput(output: string): ParsedReportData {
    const lines = output.split("\n");
    const tests: TestResult[] = [];
    const performanceMetrics: ParsedPerformanceMetric[] = [];
    const summary: TestSummary = { pass: 0, fail: 0, total: 0, time: "", files: 0, assertions: 0 };

    const perfRegex = /\[Performance\] (.*) took (.*)ms/;
    const testRegex = /(?:✓|\(pass\)) (.*) \[(.*)ms\]/;
    const failRegex = /(?:✗|\(fail\)) (.*)/;

    for (const line of lines) {
        const perfMatch = line.match(perfRegex);
        if (perfMatch) {
            const name = perfMatch[1]!;
            performanceMetrics.push({
                name,
                duration: parseFloat(perfMatch[2]!),
                category: categorizePerformanceMetric(name),
            });
        }

        const testMatch = line.match(testRegex);
        if (testMatch) {
            tests.push({ name: testMatch[1]!, duration: parseFloat(testMatch[2]!), status: "pass" });
            summary.pass++;
            summary.total++;
        }

        const failMatch = line.match(failRegex);
        if (failMatch) {
            tests.push({ name: failMatch[1]!, status: "fail" });
            summary.fail++;
            summary.total++;
        }

        if (line.includes("Ran ") && line.includes(" tests across ")) {
            summary.time = line.split("[")[1]?.split("]")[0] || "";
            const ranMatch = line.match(/Ran\s+(\d+)\s+tests\s+across\s+(\d+)\s+files/i);
            if (ranMatch) {
                summary.total = Number(ranMatch[1]);
                summary.files = Number(ranMatch[2]);
            }
        }

        const assertionMatch = line.match(/(\d+)\s+(?:expect\(\) calls|assertions)/i);
        if (assertionMatch) {
            summary.assertions = Number(assertionMatch[1]);
        }
    }

    return { tests, performanceMetrics, summary };
}

function readBaseline(baselinePath?: string): BaselineData | null {
    if (!baselinePath || !existsSync(baselinePath)) {
        return null;
    }

    try {
        return JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineData;
    } catch {
        return null;
    }
}

export function buildHotspots(
    performanceMetrics: ParsedPerformanceMetric[],
    baseline: BaselineData | null = null,
): PerformanceHotspot[] {
    const baselineByName = new Map(
        baseline?.performanceMetrics?.map((metric) => [metric.name, metric.duration]) ?? [],
    );

    return [...performanceMetrics]
        .sort((a, b) => b.duration - a.duration)
        .map((metric, index) => {
            const baselineDuration = baselineByName.get(metric.name);
            const delta = baselineDuration === undefined ? undefined : metric.duration - baselineDuration;
            const deltaPercent = baselineDuration && delta !== undefined
                ? (delta / baselineDuration) * 100
                : undefined;

            return {
                ...metric,
                rank: index + 1,
                baselineDuration,
                delta,
                deltaPercent,
            };
        });
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatDelta(hotspot: PerformanceHotspot): string {
    if (hotspot.delta === undefined || hotspot.deltaPercent === undefined) {
        return "No baseline";
    }

    const sign = hotspot.delta >= 0 ? "+" : "";
    return `${sign}${hotspot.delta.toFixed(2)} ms (${sign}${hotspot.deltaPercent.toFixed(1)}%)`;
}

function formatDuration(duration: number): string {
    return duration < 1 ? "<1 ms" : `${duration.toFixed(2)} ms`;
}

function formatGeneratedDate(date: Date = new Date()): string {
    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
}

function buildPerformanceTable(metrics: ParsedPerformanceMetric[]): string {
    if (metrics.length === 0) {
        return "_No performance metrics were emitted by this run._";
    }

    const rows = [...metrics]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((metric) => {
            const [component, ...operationParts] = metric.name.split(".");
            const operation = operationParts.join(".") || metric.name;
            const note = PERFORMANCE_NOTES[metric.name] ?? metric.category;
            return `| **${component}** | \`${operation}\` | **${formatDuration(metric.duration)}** | ${note} |`;
        });

    return [
        "| Component | Operation | Duration | Note |",
        "| :--- | :--- | :--- | :--- |",
        ...rows,
    ].join("\n");
}

export function generateReadmeReport(data: ParsedReportData): string {
    const { summary, performanceMetrics } = data;
    const statusIcon = summary.fail === 0 ? "✅" : "⚠️";
    const result = `**${summary.pass} pass / ${summary.fail} fail / ${summary.assertions} assertions** across ${summary.files || "-"} files${summary.time ? ` in **${summary.time}**` : ""}.`;

    return [
        `${README_REPORT_START}`,
        `# Performance Snapshot (${formatGeneratedDate()}) ${statusIcon}`,
        "",
        `The system has been verified with **${summary.total} automated tests**. Below are the latest local performance metrics from the server test suite:`,
        "",
        buildPerformanceTable(performanceMetrics),
        "",
        "Latest verification command:",
        "",
        "```bash",
        "bun run test",
        "```",
        "",
        `Result: ${result}`,
        "",
        "Generated reports:",
        "- `test-report.html`",
        "- `performance-report.json`",
        `${README_REPORT_END}`,
    ].join("\n");
}

export function syncReadme(data: ParsedReportData, readmePath: string = join(process.cwd(), "README.md")): void {
    const readme = readFileSync(readmePath, "utf8");
    const generated = generateReadmeReport(data);
    const markerRegex = new RegExp(`${README_REPORT_START}[\\s\\S]*?${README_REPORT_END}`);

    let nextReadme: string;
    if (markerRegex.test(readme)) {
        nextReadme = readme.replace(markerRegex, generated);
    } else {
        const hardwareHeading = "\n## Hardware & Environment";
        const hardwareIndex = readme.indexOf(hardwareHeading);
        if (hardwareIndex === -1) {
            nextReadme = `${readme.trimEnd()}\n\n${generated}\n`;
        } else {
            const intro = readme.slice(0, hardwareIndex);
            const rest = readme.slice(hardwareIndex);
            const withoutLegacySnapshot = intro.replace(/\n?# Performance Snapshot[\s\S]*$/u, "").trimEnd();
            nextReadme = `${withoutLegacySnapshot}\n\n${generated}\n${rest}`;
        }
    }

    writeFileSync(readmePath, nextReadme);
    console.log(`README synced: ${readmePath}`);
}

export function generateHtml(data: ParsedReportData, baseline: BaselineData | null = null): string {
    const { tests, performanceMetrics, summary } = data;
    const hotspots = buildHotspots(performanceMetrics, baseline);

    const rows = tests.map((testResult) => `
        <tr class="${testResult.status}">
            <td>${testResult.status === "pass" ? "PASS" : "FAIL"}</td>
            <td>${escapeHtml(testResult.name)}</td>
            <td>${testResult.duration ? testResult.duration.toFixed(2) + "ms" : "-"}</td>
        </tr>
    `).join("");

    const perfRows = hotspots.map((metric) => `
        <tr>
            <td>${metric.rank}</td>
            <td>${escapeHtml(metric.name)}</td>
            <td>${metric.category}</td>
            <td class="perf-val">${metric.duration.toFixed(2)} ms</td>
            <td>${formatDelta(metric)}</td>
        </tr>
    `).join("");

    const candidates = ALGORITHM_CANDIDATES.map((candidate) => `
        <li>${escapeHtml(candidate)}</li>
    `).join("");

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Home Assistant - Test Report</title>
    <style>
        :root {
            --bg: #10151f;
            --card-bg: #182230;
            --text: #f8fafc;
            --text-muted: #a6b3c2;
            --success: #22c55e;
            --error: #ef4444;
            --accent: #38bdf8;
            --border: rgba(255, 255, 255, 0.08);
        }
        body {
            font-family: Inter, system-ui, -apple-system, sans-serif;
            background: var(--bg);
            color: var(--text);
            margin: 0;
            padding: 40px;
        }
        .container {
            width: 100%;
            max-width: 1040px;
            margin: 0 auto;
        }
        header {
            margin-bottom: 32px;
        }
        h1 {
            font-size: 2.25rem;
            margin: 0 0 8px;
        }
        p {
            color: var(--text-muted);
            margin: 0;
        }
        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
            margin-bottom: 28px;
        }
        .card, section {
            background: var(--card-bg);
            border-radius: 8px;
            border: 1px solid var(--border);
        }
        .card {
            padding: 20px;
        }
        .card .label {
            color: var(--text-muted);
            font-size: 0.875rem;
            margin-bottom: 8px;
        }
        .card .value {
            font-size: 1.75rem;
            font-weight: 700;
        }
        .card.pass .value { color: var(--success); }
        .card.fail .value { color: var(--error); }
        section {
            padding: 28px;
            margin-bottom: 24px;
        }
        h2 {
            margin: 0 0 20px;
            font-size: 1.25rem;
            color: var(--accent);
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th {
            text-align: left;
            color: var(--text-muted);
            font-size: 0.8125rem;
            padding: 10px;
            border-bottom: 1px solid var(--border);
        }
        td {
            padding: 12px 10px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        tr.fail { color: var(--error); }
        .perf-val {
            font-family: "JetBrains Mono", ui-monospace, monospace;
            color: var(--accent);
            font-weight: 600;
        }
        li {
            color: var(--text-muted);
            margin-bottom: 8px;
        }
        .timestamp {
            margin-top: 32px;
            color: var(--text-muted);
            font-size: 0.875rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Test Automation Report</h1>
            <p>Home Assistant Server Components</p>
        </header>

        <div class="summary-cards">
            <div class="card">
                <div class="label">Total Tests</div>
                <div class="value">${summary.total}</div>
            </div>
            <div class="card pass">
                <div class="label">Passed</div>
                <div class="value">${summary.pass}</div>
            </div>
            <div class="card fail">
                <div class="label">Failed</div>
                <div class="value">${summary.fail}</div>
            </div>
            <div class="card">
                <div class="label">Execution Time</div>
                <div class="value">${escapeHtml(summary.time || "-")}</div>
            </div>
        </div>

        <section>
            <h2>Performance Hotspots</h2>
            <table>
                <thead>
                    <tr>
                        <th>Rank</th>
                        <th>Module / Operation</th>
                        <th>Category</th>
                        <th>Duration</th>
                        <th>Baseline Delta</th>
                    </tr>
                </thead>
                <tbody>
                    ${perfRows}
                </tbody>
            </table>
        </section>

        <section>
            <h2>Algorithm Candidates</h2>
            <ul>${candidates}</ul>
        </section>

        <section>
            <h2>Test Results</h2>
            <table>
                <thead>
                    <tr>
                        <th style="width: 72px">Status</th>
                        <th>Test Case</th>
                        <th>Duration</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </section>

        <div class="timestamp">
            Generated at: ${new Date().toLocaleString()}
        </div>
    </div>
</body>
</html>
    `;
}

async function main() {
    const { output, code } = await runTests();
    const data = parseOutput(output);
    const baseline = readBaseline(join(process.cwd(), "performance-baseline.json"));
    const html = generateHtml(data, baseline);

    const reportPath = join(process.cwd(), "test-report.html");
    writeFileSync(reportPath, html);
    writeFileSync(
        join(process.cwd(), "performance-report.json"),
        JSON.stringify({ ...data, hotspots: buildHotspots(data.performanceMetrics, baseline) }, null, 2),
    );
    syncReadme(data);

    console.log(`\nReport generated successfully: ${reportPath}`);
    if (code !== 0) {
        process.exit(1);
    }
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
