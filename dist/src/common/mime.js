"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guessMimeType = guessMimeType;
function guessMimeType(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    const mimeMap = {
        // Common image formats
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'bmp': 'image/bmp',
        'svg': 'image/svg+xml',
        // RAW formats
        'raf': 'image/x-raw', // Fuji
        'nef': 'image/x-raw', // Nikon
        'arw': 'image/x-raw', // Sony
        'cr2': 'image/x-raw', // Canon
        'cr3': 'image/x-raw', // Canon
        'dng': 'image/x-raw', // Adobe
        'orf': 'image/x-raw', // Olympus
        'rw2': 'image/x-raw', // Panasonic
    };
    return ext ? mimeMap[ext] : undefined;
}
