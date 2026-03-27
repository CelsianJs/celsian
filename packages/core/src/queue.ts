// @celsian/core — Queue backend interface + in-memory implementation

export interface QueueMessage {
  id: string;
  taskName: string;
  input: unknown;
  attempt: number;
  maxRetries: number;
  createdAt: number;
  availableAt: number;
}

export interface QueueBackend {
  push(message: QueueMessage): Promise<void>;
  pop(): Promise<QueueMessage | null>;
  ack(id: string): Promise<void>;
  nack(id: string, delay?: number): Promise<void>;
  size(): Promise<number>;
}

let _queueIdCounter = 0;

export function generateQueueId(): string {
  _queueIdCounter = (_queueIdCounter + 1) % 0x7FFFFFFF;
  return Date.now().toString(36) + '-' + _queueIdCounter.toString(36);
}

export interface MemoryQueueOptions {
  /** Maximum number of completed job IDs to track. Oldest are evicted first. Default: 1000 */
  maxCompletedJobs?: number;
}

export class MemoryQueue implements QueueBackend {
  private messages: QueueMessage[] = [];
  private inFlight = new Map<string, QueueMessage>();
  private completed: string[] = [];
  private readonly maxCompletedJobs: number;

  constructor(options: MemoryQueueOptions = {}) {
    this.maxCompletedJobs = options.maxCompletedJobs ?? 1000;
  }

  async push(message: QueueMessage): Promise<void> {
    this.messages.push(message);
  }

  async pop(): Promise<QueueMessage | null> {
    const now = Date.now();
    const idx = this.messages.findIndex(m => m.availableAt <= now);
    if (idx === -1) return null;

    const [message] = this.messages.splice(idx, 1);
    this.inFlight.set(message!.id, message!);
    return message!;
  }

  async ack(id: string): Promise<void> {
    this.inFlight.delete(id);
    this.completed.push(id);
    // Evict oldest completed jobs when over limit
    if (this.completed.length > this.maxCompletedJobs) {
      this.completed.splice(0, this.completed.length - this.maxCompletedJobs);
    }
  }

  async nack(id: string, delay = 1000): Promise<void> {
    const message = this.inFlight.get(id);
    if (message) {
      this.inFlight.delete(id);
      message.attempt++;
      message.availableAt = Date.now() + delay;
      this.messages.push(message);
    }
  }

  async size(): Promise<number> {
    return this.messages.length;
  }
}
