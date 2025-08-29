#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ndjson_1 = require("../src/common/ndjson");
const logger_1 = require("../src/common/logger");
const logger = new logger_1.NdjsonLogger('agent');
let currentSessionId = null;
let cancelled = false;
// Read stdin as NDJSON
(0, ndjson_1.createNdjsonReader)(process.stdin, (obj) => {
    logger.line('recv', obj);
    if (!obj || obj.jsonrpc !== '2.0' || typeof obj.method !== 'string')
        return;
    const id = obj.id;
    const method = obj.method;
    const params = obj.params || {};
    if (method === 'initialize') {
        const result = {
            protocolVersion: 1,
            agentCapabilities: {
                loadSession: false,
                promptCapabilities: { image: false, audio: false, embeddedContext: false }
            },
            authMethods: []
        };
        send({ jsonrpc: '2.0', id, result });
        return;
    }
    if (method === 'session/new') {
        if (!params.cwd || !params.cwd.startsWith('/')) {
            send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'cwd must be absolute' } });
            return;
        }
        currentSessionId = `sess_${Math.random().toString(36).slice(2, 10)}`;
        send({ jsonrpc: '2.0', id, result: { sessionId: currentSessionId } });
        return;
    }
    if (method === 'session/prompt') {
        if (!currentSessionId || params.sessionId !== currentSessionId) {
            send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'invalid session' } });
            return;
        }
        cancelled = false;
        const text = (params.prompt && params.prompt[0] && params.prompt[0].text) || '';
        // Simulate small delay then stream one chunk
        setTimeout(() => {
            if (!cancelled) {
                notify('session/update', {
                    sessionId: currentSessionId,
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: text === 'ping' ? 'pong' : `echo:${text}` }
                });
            }
            // Then respond with stopReason
            const stopReason = cancelled ? 'cancelled' : 'end_turn';
            send({ jsonrpc: '2.0', id, result: { stopReason } });
        }, 30);
        return;
    }
    if (method === 'session/cancel') {
        cancelled = true;
        // Not a request in Phase 0; treat as notification but be lenient
        if (id !== undefined) {
            send({ jsonrpc: '2.0', id, result: { ok: true } });
        }
        return;
    }
    // Unknown
    if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
    }
});
function send(obj) {
    logger.line('send', obj);
    process.stdout.write(JSON.stringify(obj) + '\n');
}
function notify(method, params) {
    const msg = { jsonrpc: '2.0', method, params };
    send(msg);
}
