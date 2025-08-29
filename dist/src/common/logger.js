"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NdjsonLogger = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class NdjsonLogger {
    constructor(prefix) {
        this.stream = null;
        const logsDir = path_1.default.resolve(process.cwd(), 'logs');
        fs_1.default.mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = path_1.default.join(logsDir, `${prefix}-${ts}.ndjson`);
        this.stream = fs_1.default.createWriteStream(this.filePath, { flags: 'a' });
    }
    line(dir, data) {
        const rec = { t: new Date().toISOString(), dir, data };
        const s = JSON.stringify(rec);
        this.stream?.write(s + '\n');
    }
    get path() { return this.filePath; }
}
exports.NdjsonLogger = NdjsonLogger;
