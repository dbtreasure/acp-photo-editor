"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonRpcPeer = void 0;
const ndjson_1 = require("./ndjson");
class JsonRpcPeer {
    constructor(read, write, logger) {
        this.nextId = 1;
        this.pending = new Map();
        this.notifyHandlers = new Map();
        this.writer = write;
        this.logger = logger;
        (0, ndjson_1.createNdjsonReader)(read, (obj) => this.onMessage(obj));
    }
    onMessage(obj) {
        this.logger.line('recv', obj);
        if (obj.id !== undefined && (obj.result !== undefined || obj.error)) {
            const p = this.pending.get(obj.id);
            if (p) {
                this.pending.delete(obj.id);
                if (obj.error)
                    p.reject(obj.error);
                else
                    p.resolve(obj.result);
            }
            return;
        }
        if (obj.method) {
            // notification only (Phase 0)
            const cbs = this.notifyHandlers.get(obj.method) || [];
            for (const cb of cbs)
                cb(obj.params);
            return;
        }
    }
    on(method, cb) {
        const arr = this.notifyHandlers.get(method) || [];
        arr.push(cb);
        this.notifyHandlers.set(method, arr);
    }
    async request(method, params) {
        const id = this.nextId++;
        const msg = { jsonrpc: '2.0', id, method, params };
        this.sendRaw(msg);
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
    }
    notify(method, params) {
        const msg = { jsonrpc: '2.0', method, params };
        this.sendRaw(msg);
    }
    sendRaw(obj) {
        this.logger.line('send', obj);
        this.writer.write(JSON.stringify(obj) + '\n');
    }
}
exports.JsonRpcPeer = JsonRpcPeer;
