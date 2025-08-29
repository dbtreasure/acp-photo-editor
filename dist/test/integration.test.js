"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
function runDemo() {
    return new Promise((resolve) => {
        const client = path_1.default.resolve(__dirname, '../dist/cmd/photo-client.js');
        const agent = 'node';
        const agentArgs = path_1.default.resolve(__dirname, '../dist/cmd/photo-agent.js');
        const cwd = path_1.default.resolve(__dirname, '..');
        const proc = (0, child_process_1.spawn)('node', [client, '--agent', agent, '--agentArgs', agentArgs, '--cwd', cwd, '--demo', 'ping'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const lines = [];
        proc.stdout.on('data', (buf) => {
            const s = buf.toString('utf8');
            for (const line of s.split('\n')) {
                if (line.trim().length)
                    lines.push(line.trim());
            }
        });
        proc.on('close', (code) => resolve({ code: code ?? -1, out: lines }));
    });
}
(0, vitest_1.describe)('Phase 0 demo', () => {
    (0, vitest_1.it)('runs end-to-end and returns end_turn', async () => {
        const { code, out } = await runDemo();
        (0, vitest_1.expect)(code).toBe(0);
        const hasChunk = out.some(l => l.startsWith('DEMO:CHUNK') && l.includes('pong'));
        const hasStop = out.some(l => l.startsWith('DEMO:STOP') && l.includes('end_turn'));
        (0, vitest_1.expect)(hasChunk).toBe(true);
        (0, vitest_1.expect)(hasStop).toBe(true);
    });
});
