"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNdjsonReader = createNdjsonReader;
const readline_1 = __importDefault(require("readline"));
function createNdjsonReader(input, onJson) {
    const rl = readline_1.default.createInterface({ input });
    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        try {
            const obj = JSON.parse(trimmed);
            onJson(obj);
        }
        catch (err) {
            // ignore malformed lines
        }
    });
    return rl;
}
