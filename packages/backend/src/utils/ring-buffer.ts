export class RingBuffer<T> {
    private buffer: T[];
    private head = 0;
    private count = 0;

    constructor(private capacity: number) {
        this.buffer = new Array(capacity);
    }

    push(item: T): void {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) {
            this.count++;
        }
    }

    toArray(): T[] {
        if (this.count === 0) return [];

        if (this.count < this.capacity) {
            return this.buffer.slice(0, this.count);
        }

        // Buffer is full — read from head (oldest) to end, then start to head
        return [
            ...this.buffer.slice(this.head),
            ...this.buffer.slice(0, this.head),
        ];
    }

    clear(): void {
        this.head = 0;
        this.count = 0;
    }

    get size(): number {
        return this.count;
    }
}
