#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const minimist_1 = __importDefault(require("minimist"));
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const readline_1 = __importDefault(require("readline"));
const jsonrpc_1 = require("../src/common/jsonrpc");
const logger_1 = require("../src/common/logger");
const mime_1 = require("../src/common/mime");
const args = (0, minimist_1.default)(process.argv.slice(2), {
    string: ['agent', 'agentArgs', 'cwd', 'demo'],
    boolean: ['interactive'],
    alias: { i: 'interactive' },
    default: {}
});
const logger = new logger_1.NdjsonLogger('client');
async function main() {
    const agentCmd = args.agent || process.env.ACP_AGENT || '';
    const agentArgs = (args.agentArgs ? String(args.agentArgs).split(' ') : []);
    const cwd = path_1.default.resolve(args.cwd || process.cwd());
    if (!agentCmd) {
        console.error('photo-client: --agent <cmd> is required');
        process.exit(2);
    }
    // Spawn agent
    const child = (0, child_process_1.spawn)(agentCmd, agentArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
    const peer = new jsonrpc_1.JsonRpcPeer(child.stdout, child.stdin, logger);
    // Demo mode: run handshake and ping
    if (args.demo === 'ping') {
        try {
            const initRes = await peer.request('initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
            });
            console.log('DEMO:INIT:OK', JSON.stringify(initRes));
            const newRes = await peer.request('session/new', { cwd, mcpServers: [] });
            const sessionId = newRes.sessionId;
            console.log('DEMO:SESSION', sessionId);
            peer.on('session/update', (params) => {
                const content = params?.content?.text ?? '';
                console.log('DEMO:CHUNK', content);
            });
            const pRes = await peer.request('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: 'ping' }]
            });
            console.log('DEMO:STOP', pRes.stopReason);
            process.exit(pRes.stopReason === 'end_turn' ? 0 : 3);
        }
        catch (err) {
            console.error('DEMO:ERROR', err?.message || String(err));
            process.exit(1);
        }
        return;
    }
    // Initialize protocol
    try {
        const initRes = await peer.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
        });
        console.log('Connected to agent');
        console.log(`Protocol version: ${initRes.protocolVersion}`);
        console.log(`Agent capabilities:`, JSON.stringify(initRes.agentCapabilities, null, 2));
        // Check for version mismatch
        if (initRes.protocolVersion !== 1) {
            console.error(`ERROR: Protocol version mismatch. Client supports version 1, agent returned version ${initRes.protocolVersion}`);
            process.exit(1);
        }
        const newRes = await peer.request('session/new', { cwd, mcpServers: [] });
        const sessionId = newRes.sessionId;
        console.log(`Session created: ${sessionId}`);
        // Set up session update handler
        peer.on('session/update', (params) => {
            const content = params?.content?.text ?? '';
            console.log(`[agent] ${content}`);
        });
        // Interactive mode with REPL
        if (args.interactive) {
            console.log('\nPhoto Editor ACP Client - Interactive Mode');
            console.log('Commands:');
            console.log('  :ping            - Send a ping message to the agent');
            console.log('  :open <path...>  - Open image file(s)');
            console.log('  :cancel          - Cancel the current prompt');
            console.log('  :exit            - Exit the client');
            console.log('');
            const rl = readline_1.default.createInterface({
                input: process.stdin,
                output: process.stdout,
                prompt: '> '
            });
            let currentPromptId = null;
            let isPrompting = false;
            rl.prompt();
            rl.on('line', async (line) => {
                const cmd = line.trim();
                if (cmd === ':exit') {
                    console.log('Goodbye!');
                    rl.close();
                    process.exit(0);
                }
                else if (cmd === ':ping') {
                    if (isPrompting) {
                        console.log('A prompt is already in progress. Use :cancel to cancel it.');
                    }
                    else {
                        isPrompting = true;
                        console.log('Sending ping...');
                        try {
                            const pRes = await peer.request('session/prompt', {
                                sessionId,
                                prompt: [{ type: 'text', text: 'ping' }]
                            });
                            console.log(`[result] stopReason: ${pRes.stopReason}`);
                        }
                        catch (e) {
                            console.error('[error]', e?.message || String(e));
                        }
                        isPrompting = false;
                    }
                }
                else if (cmd.startsWith(':open ')) {
                    if (isPrompting) {
                        console.log('A prompt is already in progress. Use :cancel to cancel it.');
                    }
                    else {
                        const parts = cmd.substring(6).trim().split(/\s+/);
                        if (parts.length === 0 || parts[0] === '') {
                            console.log('Usage: :open <path1> [path2...]');
                        }
                        else {
                            isPrompting = true;
                            console.log('Opening resources...');
                            // Build prompt with text and resource_links
                            const prompt = [
                                { type: 'text', text: 'open assets' }
                            ];
                            // Convert paths to absolute file:// URIs
                            const resources = parts.map(p => {
                                const absPath = path_1.default.resolve(p);
                                const basename = path_1.default.basename(absPath);
                                const uri = `file://${absPath}`;
                                const mimeType = (0, mime_1.guessMimeType)(basename);
                                return {
                                    type: 'resource_link',
                                    uri,
                                    name: basename,
                                    ...(mimeType && { mimeType })
                                };
                            });
                            prompt.push(...resources);
                            // Display table
                            console.log('\nResources:');
                            console.log('Name\t\tURI\t\t\t\tMIME\t\tStatus');
                            console.log('----\t\t---\t\t\t\t----\t\t------');
                            resources.forEach(r => {
                                const shortUri = r.uri.length > 30 ? '...' + r.uri.slice(-27) : r.uri;
                                console.log(`${r.name}\t${shortUri}\t${r.mimeType || 'unknown'}\tSENDING`);
                            });
                            // Log the prompt summary
                            logger.line('info', {
                                prompt_summary: `${resources.length} resources: ${resources.map(r => r.name).join(', ')}`
                            });
                            try {
                                const pRes = await peer.request('session/prompt', {
                                    sessionId,
                                    prompt
                                });
                                console.log(`\n[result] stopReason: ${pRes.stopReason}`);
                                // Update table with ACKED status
                                console.log('\nResources (updated):');
                                console.log('Name\t\tURI\t\t\t\tMIME\t\tStatus');
                                console.log('----\t\t---\t\t\t\t----\t\t------');
                                resources.forEach(r => {
                                    const shortUri = r.uri.length > 30 ? '...' + r.uri.slice(-27) : r.uri;
                                    console.log(`${r.name}\t${shortUri}\t${r.mimeType || 'unknown'}\tACKED`);
                                });
                            }
                            catch (e) {
                                console.error('[error]', e?.message || String(e));
                            }
                            isPrompting = false;
                        }
                    }
                }
                else if (cmd === ':cancel') {
                    if (!isPrompting) {
                        console.log('No prompt in progress to cancel.');
                    }
                    else {
                        console.log('Sending cancel...');
                        peer.notify('session/cancel', { sessionId });
                    }
                }
                else if (cmd.startsWith(':')) {
                    console.log(`Unknown command: ${cmd}`);
                }
                else if (cmd.length > 0) {
                    // Send custom text (for future phases)
                    if (isPrompting) {
                        console.log('A prompt is already in progress. Use :cancel to cancel it.');
                    }
                    else {
                        isPrompting = true;
                        console.log(`Sending: ${cmd}`);
                        try {
                            const pRes = await peer.request('session/prompt', {
                                sessionId,
                                prompt: [{ type: 'text', text: cmd }]
                            });
                            console.log(`[result] stopReason: ${pRes.stopReason}`);
                        }
                        catch (e) {
                            console.error('[error]', e?.message || String(e));
                        }
                        isPrompting = false;
                    }
                }
                rl.prompt();
            });
            rl.on('close', () => {
                process.exit(0);
            });
        }
        else {
            // Default non-interactive mode: just send ping and exit
            const pRes = await peer.request('session/prompt', {
                sessionId, prompt: [{ type: 'text', text: 'ping' }]
            });
            console.log(`[result] stopReason=${pRes.stopReason}`);
            process.exit(0);
        }
    }
    catch (e) {
        console.error('ERR', e?.message || String(e));
        process.exit(1);
    }
}
main().catch(e => {
    console.error(e);
    process.exit(1);
});
