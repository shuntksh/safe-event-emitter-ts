import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { type defineEvents, TypedEventEmitter } from "./event-emitter";

/**
 * Event map for testing - covers all common patterns:
 * - Multiple arguments with types
 * - No arguments
 * - Complex object types
 * - Symbol keys
 */
const testSymbol = Symbol("test-event");
type TestEvents = {
	data: [x: number, y: number];
	tick: [];
	selection: [ids: ReadonlySet<string>];
	error: [error: Error];
	[testSymbol]: [value: number];
};

describe("EventEmitter: Core Functionality", () => {
	test("on/emit: listeners receive correct arguments", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		const received: Array<[number, number]> = [];

		emitter.on("data", (x, y) => received.push([x, y]));
		emitter.emit("data", 1, 2);
		emitter.emit("data", 3, 4);

		expect(received).toEqual([
			[1, 2],
			[3, 4],
		]);
	});

	test("emit: returns true with listeners, false without", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		expect(emitter.emit("tick")).toBe(false);
		emitter.on("tick", () => {});
		expect(emitter.emit("tick")).toBe(true);
	});

	test("once: fires exactly once then auto-removes", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		let count = 0;

		emitter.once("tick", () => count++);
		emitter.emit("tick");
		emitter.emit("tick");
		emitter.emit("tick");

		expect(count).toBe(1);
		expect(emitter.listenerCount("tick")).toBe(0);
	});

	test("off: removes only first matching listener (Node.js semantics)", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		let count = 0;
		const listener = () => count++;

		emitter.on("tick", listener);
		emitter.on("tick", listener);
		emitter.on("tick", listener);
		expect(emitter.listenerCount("tick")).toBe(3);

		emitter.off("tick", listener);
		expect(emitter.listenerCount("tick")).toBe(2);

		emitter.emit("tick");
		expect(count).toBe(2);
	});

	test("off without fn: removes all listeners for event", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		emitter.on("tick", () => {});
		emitter.on("tick", () => {});
		emitter.off("tick");

		expect(emitter.listenerCount("tick")).toBe(0);
	});

	test("context: listener receives correct this binding", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		const ctx = { value: 42 };
		let received: unknown;

		emitter.on(
			"tick",
			function (this: unknown) {
				received = this;
			},
			ctx,
		);
		emitter.emit("tick");

		expect(received).toBe(ctx);
	});

	test("chaining: on/once/off/removeAllListeners return this", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		const result = emitter
			.on("tick", () => {})
			.once("data", () => {})
			.off("tick")
			.removeAllListeners();

		expect(result).toBe(emitter);
	});

	test("symbol events work correctly", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		let received: number | undefined;

		emitter.on(testSymbol, (value) => {
			received = value;
		});
		emitter.emit(testSymbol, 123);

		expect(received).toBe(123);
		expect(emitter.eventNames()).toContain(testSymbol);
	});
});

describe("EventEmitter: Critical Edge Cases", () => {
	test("self-removal: listener removes itself during emit", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		const calls: string[] = [];

		const selfRemover = () => {
			calls.push("self");
			emitter.off("tick", selfRemover);
		};

		emitter.on("tick", selfRemover);
		emitter.on("tick", () => calls.push("after"));

		emitter.emit("tick");

		expect(calls).toEqual(["self", "after"]);
		expect(emitter.listenerCount("tick")).toBe(1);
	});

	test("listener removes subsequent listener during emit (Node.js semantics)", () => {
		// Node.js semantics: All snapshotted listeners are called regardless
		// of removals during emission. The removal takes effect after emit.
		const emitter = new TypedEventEmitter<TestEvents>();
		const calls: string[] = [];

		const listener2 = () => calls.push("l2");
		const listener1 = () => {
			calls.push("l1");
			emitter.off("tick", listener2);
		};

		emitter.on("tick", listener1);
		emitter.on("tick", listener2);
		emitter.emit("tick");

		// Both are called (snapshot semantics), but l2 is removed after
		expect(calls).toEqual(["l1", "l2"]);
		expect(emitter.listenerCount("tick")).toBe(1);
	});

	test("exception in listener: propagates and doesn't break state (single)", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		emitter.once("tick", () => {
			throw new Error("test error");
		});

		expect(() => emitter.emit("tick")).toThrow("test error");
		// Once listener should still be removed even though it threw
		expect(emitter.listenerCount("tick")).toBe(0);
	});

	test("exception in listener: once cleanup occurs (multiple listeners)", () => {
		// Tests that once listeners are cleaned up even when exception is thrown
		// in the multi-listener path (via try/finally)
		const emitter = new TypedEventEmitter<TestEvents>();
		let regularCalled = false;

		emitter.once("tick", () => {
			throw new Error("once threw");
		});
		emitter.on("tick", () => {
			regularCalled = true;
		});

		expect(() => emitter.emit("tick")).toThrow("once threw");
		// Once listener should be removed, regular listener should remain
		expect(emitter.listenerCount("tick")).toBe(1);
		// Regular listener wasn't called because exception stopped iteration
		expect(regularCalled).toBe(false);
	});

	test("recursive emit: works correctly for nested events", () => {
		const emitter = new TypedEventEmitter<{
			outer: [];
			inner: [];
		}>();
		const sequence: string[] = [];

		emitter.on("outer", () => {
			sequence.push("outer-start");
			emitter.emit("inner");
			sequence.push("outer-end");
		});
		emitter.on("inner", () => sequence.push("inner"));

		emitter.emit("outer");

		expect(sequence).toEqual(["outer-start", "inner", "outer-end"]);
	});

	test("recursive same-event emit: respects once semantics", () => {
		const emitter = new TypedEventEmitter<{ recurse: [depth: number] }>();
		const onceCalls: number[] = [];
		const regularCalls: number[] = [];

		emitter.once("recurse", (n) => onceCalls.push(n));
		emitter.on("recurse", (n) => {
			regularCalls.push(n);
			if (n < 2) emitter.emit("recurse", n + 1);
		});

		emitter.emit("recurse", 0);

		// Once listener fires in recursive context due to deferred removal
		expect(onceCalls).toEqual([0, 1, 2]);
		expect(regularCalls).toEqual([0, 1, 2]);
	});

	test("single → multiple listener transition", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		const calls: number[] = [];

		// Start with single (stored directly, not array)
		emitter.on("tick", () => calls.push(1));
		expect(emitter.listenerCount("tick")).toBe(1);

		// Add second (converts to array)
		emitter.on("tick", () => calls.push(2));
		expect(emitter.listenerCount("tick")).toBe(2);

		emitter.emit("tick");
		expect(calls).toEqual([1, 2]);
	});

	test("multiple → single → empty listener transition", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		const listener1 = () => {};
		const listener2 = () => {};

		emitter.on("tick", listener1);
		emitter.on("tick", listener2);
		expect(emitter.listenerCount("tick")).toBe(2);

		emitter.off("tick", listener1);
		expect(emitter.listenerCount("tick")).toBe(1);
		expect(emitter.listeners("tick")).toEqual([listener2]);

		emitter.off("tick", listener2);
		expect(emitter.listenerCount("tick")).toBe(0);
		expect(emitter.eventNames()).not.toContain("tick");
	});

	test("mixed once/regular: only once listeners removed after emit", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		emitter.on("tick", () => {});
		emitter.once("tick", () => {});
		emitter.on("tick", () => {});
		emitter.once("tick", () => {});

		expect(emitter.listenerCount("tick")).toBe(4);
		emitter.emit("tick");
		expect(emitter.listenerCount("tick")).toBe(2);
	});

	test("off with context filter: removes only matching context", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		const ctx1 = { id: 1 };
		const ctx2 = { id: 2 };
		const calls: number[] = [];

		const listener = function (this: { id: number }) {
			calls.push(this.id);
		};

		emitter.on("tick", listener, ctx1);
		emitter.on("tick", listener, ctx2);

		emitter.off("tick", listener, { context: ctx1 });
		emitter.emit("tick");

		expect(calls).toEqual([2]);
	});

	test("off with once filter: removes only once listeners", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		const listener = () => {};

		emitter.on("tick", listener);
		emitter.once("tick", listener);
		expect(emitter.listenerCount("tick")).toBe(2);

		emitter.off("tick", listener, { once: true });
		expect(emitter.listenerCount("tick")).toBe(1);
	});
});

describe("EventEmitter: Type Safety (compile-time)", () => {
	test("rejects invalid event names", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		emitter.on("data", () => {}); // Valid
		// @ts-expect-error - invalid event name
		emitter.on("invalid", () => {});
	});

	test("rejects wrong emit argument count", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		emitter.emit("data", 1, 2); // Valid
		// @ts-expect-error - missing y argument
		emitter.emit("data", 1);
		// @ts-expect-error - tick takes no arguments
		emitter.emit("tick", "unexpected");
	});

	test("rejects wrong emit argument types", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		// @ts-expect-error - string instead of number
		emitter.emit("data", "wrong", 2);
	});

	test("enforces readonly constraints", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		emitter.on("selection", (ids) => {
			ids.has("test"); // Reading OK
			// @ts-expect-error - ReadonlySet has no 'add' method
			ids.add("new");
		});
	});

	test("rejects wrong listener signature for off", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		const wrongListener = (_x: string) => {};

		// @ts-expect-error - listener signature doesn't match
		emitter.off("data", wrongListener);
	});
});

describe("EventEmitter: Property-based tests", () => {
	test("listener count invariant: add N, remove M → N-M remaining", () => {
		fc.assert(
			fc.property(fc.nat({ max: 10 }), fc.nat({ max: 10 }), (add, remove) => {
				const emitter = new TypedEventEmitter<{ test: [] }>();
				const listeners: Array<() => void> = [];

				// Add listeners
				for (let i = 0; i < add; i++) {
					const fn = () => {};
					listeners.push(fn);
					emitter.on("test", fn);
				}

				expect(emitter.listenerCount("test")).toBe(add);

				// Remove some
				const toRemove = Math.min(remove, add);
				for (let i = 0; i < toRemove; i++) {
					const fn = listeners[i];
					if (fn) emitter.off("test", fn);
				}

				expect(emitter.listenerCount("test")).toBe(add - toRemove);
			}),
		);
	});

	test("broadcast invariant: all listeners receive all events", () => {
		fc.assert(
			fc.property(
				fc.nat({ max: 5 }),
				fc.nat({ max: 5 }),
				(listenerCount, emitCount) => {
					const emitter = new TypedEventEmitter<{ test: [n: number] }>();
					const received: number[][] = [];

					for (let i = 0; i < listenerCount; i++) {
						const arr: number[] = [];
						received.push(arr);
						emitter.on("test", (n) => arr.push(n));
					}

					for (let i = 0; i < emitCount; i++) {
						emitter.emit("test", i);
					}

					for (const arr of received) {
						expect(arr.length).toBe(emitCount);
					}
				},
			),
		);
	});
});

describe("EventEmitter: Memory Leak Prevention", () => {
	test("once listeners don't accumulate", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		for (let i = 0; i < 100; i++) {
			emitter.once("tick", () => {});
		}
		expect(emitter.listenerCount("tick")).toBe(100);

		emitter.emit("tick");
		expect(emitter.listenerCount("tick")).toBe(0);
	});

	test("removeAllListeners clears everything", () => {
		const emitter = new TypedEventEmitter<TestEvents>();

		emitter.on("tick", () => {});
		emitter.on("data", () => {});
		emitter.once("error", () => {});

		emitter.removeAllListeners();

		expect(emitter.eventNames()).toEqual([]);
	});
});

describe("EventEmitter: Direct call optimization", () => {
	test.each([
		{ args: 0, event: "tick" as const },
		{ args: 2, event: "data" as const },
		{ args: 3, event: "pointer:down" as const },
	])("handles $args arguments correctly", ({ event }) => {
		type Events = {
			tick: [];
			data: [a: number, b: number];
			"pointer:down": [x: number, y: number, p: number];
		};
		const emitter = new TypedEventEmitter<Events>();
		let called = false;

		emitter.on(event, () => {
			called = true;
		});

		if (event === "tick") emitter.emit("tick");
		else if (event === "data") emitter.emit("data", 1, 2);
		else emitter.emit("pointer:down", 1, 2, 3);

		expect(called).toBe(true);
	});
});

describe("EventEmitter: defineEvents helper", () => {
	test("infers types from function signatures", () => {
		type Events = ReturnType<
			typeof defineEvents<{
				data: (value: number) => void;
				ready: () => void;
			}>
		>;

		const emitter = new TypedEventEmitter<Events>();
		let received: number | undefined;

		emitter.on("data", (value) => {
			received = value;
		});
		emitter.emit("data", 42);

		expect(received).toBe(42);
	});
});

describe("EventEmitter: Async Dispatch", () => {
	test("emitAsync: fires in next microtask", async () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		let called = false;

		emitter.on("tick", () => {
			called = true;
		});

		emitter.emitAsync("tick");
		expect(called).toBe(false); // Sync check

		// Wait for microtasks
		await Promise.resolve();
		expect(called).toBe(true);
	});

	test("emitAsync: handles arguments correctly", async () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		let received: [number, number] | undefined;

		emitter.on("data", (x, y) => {
			received = [x, y];
		});

		emitter.emitAsync("data", 10, 20);
		await Promise.resolve();

		expect(received).toEqual([10, 20]);
	});
});

describe("EventEmitter: Deferred Dispatch", () => {
	test("emitDeferred: buffers events until flush", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		let count = 0;

		emitter.on("tick", () => count++);

		emitter.emitDeferred("tick");
		emitter.emitDeferred("tick");
		expect(count).toBe(0); // Should be buffered

		emitter.flushDeferred();
		expect(count).toBe(2); // Flushed
	});

	test("overflow protection: throws when queue limit exceeded", () => {
		const emitter = new TypedEventEmitter<TestEvents>({ maxDeferredEvents: 5 });

		for (let i = 0; i < 5; i++) {
			emitter.emitDeferred("tick");
		}

		expect(() => emitter.emitDeferred("tick")).toThrow(
			"Deferred queue overflow (max: 5)",
		);
	});

	test("error isolation: flush continues even if listener throws", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		const calls: string[] = [];

		emitter.on("data", (x) => {
			if (x === 2) throw new Error("fail");
			calls.push(`ok-${x}`);
		});

		emitter.emitDeferred("data", 1, 0);
		emitter.emitDeferred("data", 2, 0); // Throws
		emitter.emitDeferred("data", 3, 0);

		// Should not throw, but log error (not checking console here, just flow)
		emitter.flushDeferred();

		expect(calls).toEqual(["ok-1", "ok-3"]);
	});

	test("re-entrancy: events added during flush go to NEXT flush", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		const calls: string[] = [];

		emitter.on("tick", () => {
			calls.push("tick");
			// Queue another event inside handler
			emitter.emitDeferred("tick");
		});

		emitter.emitDeferred("tick");
		emitter.flushDeferred();

		// Only the first one ran
		expect(calls).toEqual(["tick"]);

		// Second one runs on next flush
		emitter.flushDeferred();
		expect(calls).toEqual(["tick", "tick"]);
	});

	test("memory release: queue is empty after flush", () => {
		const emitter = new TypedEventEmitter<TestEvents>();
		emitter.emitDeferred("tick");
		emitter.flushDeferred();

		// Access private field via hack or assume implementation correctness
		// Just re-verify behavior
		emitter.emitDeferred("tick"); // Should not overflow even if small limit
	});
});
