
import { createNdjsonReader } from './ndjson';
import { Readable, Writable } from 'stream';
import { NdjsonLogger } from './logger';

type Pending = { resolve: (v:any)=>void, reject: (e:any)=>void };

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifyHandlers = new Map<string, ((params:any)=>void)[]>();
  private writer: Writable;
  private logger: NdjsonLogger;

  constructor(read: Readable, write: Writable, logger: NdjsonLogger) {
    this.writer = write;
    this.logger = logger;
    createNdjsonReader(read, (obj) => this.onMessage(obj));
  }

  private onMessage(obj: any) {
    this.logger.line('recv', obj);
    if (obj.id !== undefined && (obj.result !== undefined || obj.error)) {
      const p = this.pending.get(obj.id);
      if (p) {
        this.pending.delete(obj.id);
        if (obj.error) p.reject(obj.error);
        else p.resolve(obj.result);
      }
      return;
    }
    if (obj.method) {
      // Check if this is a request (has id) or notification (no id)
      if (obj.id !== undefined) {
        // This is a request that needs a response - pass the full object
        const cbs = this.notifyHandlers.get(obj.method) || [];
        for (const cb of cbs) cb(obj); // Pass full object, not just params
      } else {
        // This is a notification - pass just params
        const cbs = this.notifyHandlers.get(obj.method) || [];
        for (const cb of cbs) cb(obj.params);
      }
      return;
    }
  }

  on(method: string, cb: (params:any)=>void) {
    const arr = this.notifyHandlers.get(method) || [];
    arr.push(cb);
    this.notifyHandlers.set(method, arr);
  }

  async request(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.sendRaw(msg);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params?: any) {
    const msg = { jsonrpc: '2.0', method, params };
    this.sendRaw(msg);
  }

  send(obj: any) {
    this.sendRaw(obj);
  }
  
  private sendRaw(obj: any) {
    this.logger.line('send', obj);
    this.writer.write(JSON.stringify(obj) + '\n');
  }
}
