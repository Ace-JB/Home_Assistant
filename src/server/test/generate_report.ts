import { spawn } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";

async function runTests() {
    console.log("🚀 Running tests and generating report...");

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

function parseOutput(output: string) {
    const lines = output.split("\n");
    const tests: any[] = [];
    const performanceMetrics: any[] = [];
    let summary = { pass: 0, fail: 0, total: 0, time: "" };

    const perfRegex = /\[Performance\] (.*) took (.*)ms/;
    const testRegex = /(?:✓|\(pass\)) (.*) \[(.*)ms\]/;
    const failRegex = /(?:✗|\(fail\)) (.*)/;

    for (const line of lines) {
        const perfMatch = line.match(perfRegex);
        if (perfMatch) {
            performanceMetrics.push({ name: perfMatch[1], duration: parseFloat(perfMatch[2]!) });
        }

        const testMatch = line.match(testRegex);
        if (testMatch) {
            tests.push({ name: testMatch[1], duration: parseFloat(testMatch[2]!), status: "pass" });
            summary.pass++;
            summary.total++;
        }

        const failMatch = line.match(failRegex);
        if (failMatch) {
            tests.push({ name: failMatch[1], status: "fail" });
            summary.fail++;
            summary.total++;
        }

        if (line.includes("Ran ") && line.includes(" tests across ")) {
            summary.time = line.split("[")[1]?.split("]")[0] || "";
        }
    }

    return { tests, performanceMetrics, summary };
}

function generateHtml(data: any) {
    const { tests, performanceMetrics, summary } = data;

    const rows = tests.map((t: any) => `
        <tr class="${t.status}">
            <td>${t.status === 'pass' ? '✅' : '❌'}</td>
            <td>${t.name}</td>
            <td>${t.duration ? t.duration.toFixed(2) + 'ms' : '-'}</td>
        </tr>
    `).join("");

    const perfRows = performanceMetrics.map((p: any) => `
        <tr>
            <td>${p.name}</td>
            <td class="perf-val">${p.duration.toFixed(2)} ms</td>
        </tr>
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
            --bg: #0f172a;
            --card-bg: #1e293b;
            --text: #f8fafc;
            --text-muted: #94a3b8;
            --success: #22c55e;
            --error: #ef4444;
            --accent: #38bdf8;
        }
        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background: var(--bg);
            color: var(--text);
            margin: 0;
            padding: 40px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        .container {
            width: 100%;
            max-width: 900px;
        }
        header {
            margin-bottom: 40px;
            text-align: center;
        }
        h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
            background: linear-gradient(to right, #38bdf8, #818cf8);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }
        .card {
            background: var(--card-bg);
            padding: 24px;
            border-radius: 16px;
            box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
            border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .card .label {
            color: var(--text-muted);
            font-size: 0.875rem;
            margin-bottom: 8px;
        }
        .card .value {
            font-size: 2rem;
            font-weight: 700;
        }
        .card.pass .value { color: var(--success); }
        .card.fail .value { color: var(--error); }
        
        section {
            background: var(--card-bg);
            border-radius: 16px;
            padding: 32px;
            margin-bottom: 30px;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }
        h2 {
            margin-top: 0;
            font-size: 1.5rem;
            margin-bottom: 24px;
            color: var(--accent);
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th {
            text-align: left;
            color: var(--text-muted);
            font-size: 0.875rem;
            padding: 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        td {
            padding: 16px 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        tr.pass:hover { background: rgba(34, 197, 94, 0.05); }
        tr.fail { color: var(--error); }
        .perf-val {
            font-family: 'JetBrains Mono', monospace;
            color: var(--accent);
            font-weight: 600;
        }
        .timestamp {
            margin-top: 40px;
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
                <div class="value">${summary.time}</div>
            </div>
        </div>

        <section>
            <h2>⚡ Performance Metrics</h2>
            <table>
                <thead>
                    <tr>
                        <th>Module / Operation</th>
                        <th>Duration</th>
                    </tr>
                </thead>
                <tbody>
                    ${perfRows}
                </tbody>
            </table>
        </section>

        <section>
            <h2>🧪 Test Results</h2>
            <table>
                <thead>
                    <tr>
                        <th style="width: 40px"></th>
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
    const html = generateHtml(data);

    const reportPath = join(process.cwd(), "test-report.html");
    writeFileSync(reportPath, html);

    console.log(`\n✨ Report generated successfully: ${reportPath}`);
    if (code !== 0) {
        process.exit(1);
    }
}

main().catch(console.error);
