import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { NdjsonLogger } from './logger';
import { JsonRpcPeer } from './jsonrpc';

export interface SessionUpdateParams {
  sessionId?: string;
  sessionUpdate?: string;
  [key: string]: any;
}

export interface PermissionRequestMessage {
  id?: number;
  params?: {
    sessionId?: string;
    title?: string;
    explanation?: string;
    operations?: any[];
  };
  [key: string]: any;
}

/**
 * RpcClient wraps JsonRpcPeer and emits typed events for common notifications.
 */
export class RpcClient extends EventEmitter {
  private peer: JsonRpcPeer;

  constructor(read: Readable, write: Writable, logger: NdjsonLogger) {
    super();
    this.peer = new JsonRpcPeer(read, write, logger);
    this.peer.on('session/update', (params: any) => {
      this.emit('sessionUpdate', params as SessionUpdateParams);
    });
    this.peer.on('session/request_permission', (msg: any) => {
      this.emit('permissionRequest', msg as PermissionRequestMessage);
    });
  }

  request(method: string, params?: any) {
    return this.peer.request(method, params);
  }

  notify(method: string, params?: any) {
    this.peer.notify(method, params);
  }

  send(obj: any) {
    this.peer.send(obj);
  }

  onSessionUpdate(listener: (params: SessionUpdateParams) => void) {
    this.on('sessionUpdate', listener);
  }

  onPermissionRequest(listener: (msg: PermissionRequestMessage) => void) {
    this.on('permissionRequest', listener);
  }
}

