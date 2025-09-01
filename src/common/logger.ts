import fs from 'fs';
import path from 'path';

export type Direction = 'send' | 'recv' | 'info' | 'error';

export class NdjsonLogger {
  private stream: fs.WriteStream | null = null;
  private filePath: string;

  constructor(prefix: string) {
    const logsDir = path.resolve(process.cwd(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(logsDir, `${prefix}-${ts}.ndjson`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  line(dir: Direction, data: any) {
    const rec = { t: new Date().toISOString(), dir, data };
    const s = JSON.stringify(rec);
    this.stream?.write(s + '\n');
  }

  get path() {
    return this.filePath;
  }
}
