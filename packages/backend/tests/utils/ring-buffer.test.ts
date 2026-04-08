import { describe, expect, it } from "bun:test";
import { RingBuffer } from "../../src/utils/ring-buffer.js";

describe("RingBuffer", () => {
    it("starts empty", () => {
        const buf = new RingBuffer<number>(5);
        expect(buf.size).toBe(0);
        expect(buf.toArray()).toEqual([]);
    });

    it("pushes items and returns them in order", () => {
        const buf = new RingBuffer<number>(5);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        expect(buf.size).toBe(3);
        expect(buf.toArray()).toEqual([1, 2, 3]);
    });

    it("fills to capacity", () => {
        const buf = new RingBuffer<number>(3);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        expect(buf.size).toBe(3);
        expect(buf.toArray()).toEqual([1, 2, 3]);
    });

    it("overwrites oldest items when full", () => {
        const buf = new RingBuffer<number>(3);
        buf.push(1);
        buf.push(2);
        buf.push(3);
        buf.push(4);
        expect(buf.size).toBe(3);
        expect(buf.toArray()).toEqual([2, 3, 4]);
    });

    it("handles multiple wraparounds", () => {
        const buf = new RingBuffer<number>(3);
        for (let i = 1; i <= 10; i++) {
            buf.push(i);
        }
        expect(buf.size).toBe(3);
        expect(buf.toArray()).toEqual([8, 9, 10]);
    });

    it("clears the buffer", () => {
        const buf = new RingBuffer<number>(5);
        buf.push(1);
        buf.push(2);
        buf.clear();
        expect(buf.size).toBe(0);
        expect(buf.toArray()).toEqual([]);
    });

    it("works after clear and re-push", () => {
        const buf = new RingBuffer<number>(3);
        buf.push(1);
        buf.push(2);
        buf.clear();
        buf.push(10);
        buf.push(20);
        expect(buf.size).toBe(2);
        expect(buf.toArray()).toEqual([10, 20]);
    });

    it("works with capacity of 1", () => {
        const buf = new RingBuffer<string>(1);
        buf.push("a");
        expect(buf.toArray()).toEqual(["a"]);
        buf.push("b");
        expect(buf.toArray()).toEqual(["b"]);
        expect(buf.size).toBe(1);
    });

    it("works with string types", () => {
        const buf = new RingBuffer<string>(3);
        buf.push("hello");
        buf.push("world");
        expect(buf.toArray()).toEqual(["hello", "world"]);
    });
});
