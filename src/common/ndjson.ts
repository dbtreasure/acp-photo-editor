import readline from 'readline';
import { Readable } from 'stream';

export type JsonLineHandler = (obj: any) => void;

export function createNdjsonReader(input: Readable, onJson: JsonLineHandler) {
  const rl = readline.createInterface({ input });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const obj = JSON.parse(trimmed);
      onJson(obj);
    } catch (err) {
      // ignore malformed lines
    }
  });
  return rl;
}
