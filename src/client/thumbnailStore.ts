import { EventEmitter } from 'events';

export interface Thumbnail {
  metadata?: string;
  image?: string;
  mimeType?: string;
}

export class ThumbnailStore {
  private store: Map<string, Thumbnail> = new Map();
  public events = new EventEmitter();

  set(id: string, data: Thumbnail) {
    const existing = this.store.get(id) || {};
    const updated = { ...existing, ...data };
    this.store.set(id, updated);
    this.events.emit('update', id, updated);
  }

  get(id: string) {
    return this.store.get(id);
  }

  list(): [string, Thumbnail][] {
    return Array.from(this.store.entries());
  }
}
