/**
 * TypedEventEmitter - A high-performance, end-to-end type-safe event emitter.
 *
 * Designed for both browser and Node.js/Bun environments with zero dependencies.
 * Implements critical micro-optimizations from eventemitter3 while providing
 * strict TypeScript type safety for custom event definitions.
 *
 * Key features:
 * - End-to-end type safety: event names, payloads, and listeners are all type-checked
 * - Zero external dependencies
 * - Single listener optimization (no array allocation for single listener)
 * - Direct call optimization for 0-5 arguments (avoids Function.prototype.apply)
 * - Built-in context support (no .bind() needed)
 * - Null-prototype events object (no prototype chain lookups)
 * - Cross-platform (Browser, Node.js, Bun)
 *
 * @example
 * ```typescript
 * type MyEvents = {
 *   'data': [value: number, label: string];
 *   'error': [error: Error];
 *   'complete': [];
 * };
 *
 * const emitter = new TypedEventEmitter<MyEvents>();
 *
 * // Fully typed listeners - value inferred as number and label as string
 * emitter.on('data', (value, label) => {
 *   console.log(value.toFixed(2), label.toUpperCase());
 * });
 *
 * // Type-checked emit
 * emitter.emit('data', 42, 'test'); // OK
 * emitter.emit('data', 'wrong');    // Type error!
 * emitter.emit('unknown', 1);       // Type error!
 * ```
 *
 * @module
 */

/**
 * Event map type - maps event names to their argument tuples.
 * Use labeled tuple elements for better IDE experience.
 *
 * @example
 * ```typescript
 * type Events = {
 *   'pointer:move': [x: number, y: number, pressure: number];
 *   'frame:begin': [];
 *   'error': [error: Error];
 * };
 * ```
 */
export type EventMap = Record<string | symbol, readonly unknown[]>;

/**
 * Extract event names from an EventMap.
 */
export type EventNames<T extends EventMap> = keyof T & (string | symbol);

/**
 * Extract listener function type for a specific event.
 */
export type EventListener<
	T extends EventMap,
	K extends EventNames<T>,
> = T[K] extends readonly unknown[] ? (...args: T[K]) => void : never;

/**
 * Options for removing listeners.
 */
export type RemoveListenerOptions = {
	/** Only remove listeners with this context */
	readonly context?: unknown;
	/** Only remove one-time listeners */
	readonly once?: boolean;
};

/**
 * Internal listener wrapper structure.
 * Uses a plain object for minimal memory overhead.
 *
 * The `context` field stores the `this` value that will be bound to the listener
 * function when it's invoked (via `fn.call(context, ...args)`). This is a performance
 * optimization over using `.bind()`:
 *
 * ```typescript
 * // Without context support, users must allocate a bound function:
 * emitter.on('event', this.handleEvent.bind(this));
 *
 * // With context support, no allocation is needed:
 * emitter.on('event', this.handleEvent, this);
 * ```
 *
 * The context is also used for listener matching in `off()` - if a context was
 * provided when adding a listener, the same context can be used to identify
 * and remove that specific listener.
 */
type Listener = {
	readonly fn: (...args: readonly unknown[]) => void;
	/** The `this` value to bind when invoking `fn`. See type docs for details. */
	readonly context: unknown;
	readonly once: boolean;
};

/**
 * Internal structure for storing listeners per event.
 * Single listener is stored directly, multiple as array.
 */
type ListenerStore = Listener | Listener[];

/**
 * Create a null-prototype object for storing events.
 * Avoids prototype chain lookups and hasOwnProperty checks.
 */
function createEventsObject(): Record<string | symbol, ListenerStore> {
	return Object.create(null) as Record<string | symbol, ListenerStore>;
}

/**
 * Check if a listener store contains a single listener (has 'fn' property).
 */
function isSingleListener(store: ListenerStore): store is Listener {
	return "fn" in store;
}

/**
 * Safely get an element from an array with bounds checking.
 */
function getAt<T>(array: T[], index: number): T | undefined {
	return index >= 0 && index < array.length ? array[index] : undefined;
}

/**
 * High-performance, strictly-typed EventEmitter.
 *
 * This implementation combines eventemitter3's micro-optimizations with
 * TypeScript's type system for end-to-end type safety.
 *
 * Performance optimizations:
 * 1. Null-prototype events object (no hasOwnProperty needed)
 * 2. Single listener optimization (no array for single listener)
 * 3. Direct call optimization for 0-5 arguments (avoids .apply())
 * 4. Built-in context support (no .bind() allocation)
 * 5. Event count tracking (fast eventNames())
 *
 * @typeParam T - Event map defining event names and their argument tuples
 */
export class TypedEventEmitter<T extends EventMap> {
	/**
	 * Default maximum number of deferred events before throwing an error.
	 */
	static readonly DEFAULT_MAX_DEFERRED = 10000;

	/**
	 * Internal events storage. Uses null-prototype object.
	 * @internal
	 */
	#events: Record<string | symbol, ListenerStore> = createEventsObject();

	/**
	 * Count of events with listeners. Enables fast eventNames() checks.
	 * @internal
	 */
	#eventCount = 0;

	/**
	 * Queue for deferred events.
	 * @internal
	 */
	#deferredQueue: Array<() => void> = [];

	/**
	 * Maximum number of allowed deferred events.
	 * @internal
	 */
	readonly #maxDeferredEvents: number;

	/**
	 * Create a new TypedEventEmitter.
	 *
	 * @param options - Configuration options
	 */
	constructor(options?: { maxDeferredEvents?: number }) {
		this.#maxDeferredEvents =
			options?.maxDeferredEvents ?? TypedEventEmitter.DEFAULT_MAX_DEFERRED;
	}

	/**
	 * Add a listener for an event.
	 *
	 * @param event - The event name
	 * @param fn - The listener function
	 * @param context - Optional context (`this` value) for the listener
	 * @returns this (for chaining)
	 */
	on<K extends EventNames<T>>(
		event: K,
		fn: EventListener<T, K>,
		context?: unknown,
	): this {
		return this.#addListener(
			event,
			fn as unknown as Listener["fn"],
			context,
			false,
		);
	}

	/**
	 * Add a one-time listener for an event. It will be automatically
	 * removed after being invoked once.
	 *
	 * @param event - The event name
	 * @param fn - The listener function
	 * @param context - Optional context (`this` value) for the listener
	 * @returns this (for chaining)
	 */
	once<K extends EventNames<T>>(
		event: K,
		fn: EventListener<T, K>,
		context?: unknown,
	): this {
		return this.#addListener(
			event,
			fn as unknown as Listener["fn"],
			context,
			true,
		);
	}

	/**
	 * Internal method to add a listener.
	 * Implements single-listener optimization.
	 */
	#addListener<K extends EventNames<T>>(
		event: K,
		fn: Listener["fn"],
		context: unknown,
		once: boolean,
	): this {
		const listener: Listener = { fn, context, once };
		const existing = this.#events[event];

		if (!existing) {
			// First listener: store directly (no array)
			this.#events[event] = listener;
			this.#eventCount++;
		} else if (isSingleListener(existing)) {
			// Second listener: convert to array
			this.#events[event] = [existing, listener];
		} else {
			// Additional listeners: push to array
			existing.push(listener);
		}

		return this;
	}

	/**
	 * Remove a listener for an event.
	 *
	 * @param event - The event name
	 * @param fn - The listener function to remove. If omitted, removes all listeners for the event.
	 * @param options - Additional options for matching listeners
	 * @returns this (for chaining)
	 */
	off<K extends EventNames<T>>(
		event: K,
		fn?: EventListener<T, K>,
		options?: RemoveListenerOptions,
	): this {
		const store = this.#events[event];
		if (!store) return this;

		// If no function specified, remove all listeners for this event
		if (!fn) {
			delete this.#events[event];
			this.#eventCount--;
			return this;
		}

		const context = options?.context;
		const once = options?.once;
		const targetFn = fn as unknown as Listener["fn"];

		if (isSingleListener(store)) {
			// Single listener case
			if (
				store.fn === targetFn &&
				(once === undefined || store.once === once) &&
				(context === undefined || store.context === context)
			) {
				delete this.#events[event];
				this.#eventCount--;
			}
		} else {
			// Array case: remove only the FIRST matching listener (Node.js semantics)
			// This is more intuitive: add twice = remove twice
			let removed = false;
			const remaining: Listener[] = [];

			for (let i = 0; i < store.length; i++) {
				const listener = getAt(store, i);
				if (listener) {
					const isMatch =
						!removed &&
						listener.fn === targetFn &&
						(once === undefined || listener.once === once) &&
						(context === undefined || listener.context === context);

					if (isMatch) {
						removed = true;
						// Don't add to remaining - this is the one we're removing
					} else {
						remaining.push(listener);
					}
				}
			}

			if (!removed) {
				// No match found, nothing to do
				return this;
			}

			if (remaining.length === 0) {
				delete this.#events[event];
				this.#eventCount--;
			} else if (remaining.length === 1) {
				// Convert back to single listener
				// Safe: length === 1 guarantees remaining[0] exists
				const single = remaining[0];
				if (single) this.#events[event] = single;
			} else {
				this.#events[event] = remaining;
			}
		}

		return this;
	}

	/**
	 * Emit an event with the given arguments.
	 *
	 * @param event - The event name
	 * @param args - The event arguments (must match the EventMap definition)
	 * @returns `true` if the event had listeners, `false` otherwise
	 */
	emit<K extends EventNames<T>>(event: K, ...args: T[K]): boolean {
		const store = this.#events[event];
		if (!store) return false;

		if (isSingleListener(store)) {
			// Single listener path
			// Invoke first, then remove if once (matches Node.js semantics)
			// Use try/finally to ensure cleanup even if listener throws
			try {
				this.#invoke(store, args);
			} finally {
				// Only remove if store wasn't modified during invoke
				if (store.once && this.#events[event] === store) {
					delete this.#events[event];
					this.#eventCount--;
				}
			}
		} else {
			// Multiple listeners path
			// Snapshot the listeners to iterate safely - prevents issues when
			// a listener removes another listener during emission (correctness > performance)
			// Note: At this point, store is guaranteed to be Listener[] (not single Listener)
			const listenersToInvoke = store.slice();
			let hasOnceListeners = false;

			try {
				// Invoke all snapshotted listeners (Node.js semantics)
				// Listeners removed during emit are still called if they were
				// present at snapshot time - this matches Node.js EventEmitter
				for (const listener of listenersToInvoke) {
					if (listener.once) hasOnceListeners = true;
					this.#invoke(listener, args);
				}
			} finally {
				// After invoking, clean up 'once' listeners from current state
				// Handle both array and single-listener states (mutations may have reduced it)
				// Use finally to ensure cleanup even if listener throws
				if (hasOnceListeners) {
					const currentStore = this.#events[event];
					if (!currentStore) {
						// All listeners were removed during emit, nothing to do
					} else if (isSingleListener(currentStore)) {
						// Store was reduced to single listener - check if it's once
						if (currentStore.once) {
							delete this.#events[event];
							this.#eventCount--;
						}
					} else {
						// Still an array - filter out once listeners
						const remaining = currentStore.filter((l) => !l.once);

						if (remaining.length === 0) {
							delete this.#events[event];
							this.#eventCount--;
						} else if (remaining.length === 1) {
							// Safe: length === 1 guarantees remaining[0] exists
							const single = remaining[0];
							if (single) this.#events[event] = single;
						} else {
							this.#events[event] = remaining;
						}
					}
				}
			}
		}

		return true;
	}

	/**
	 * Emit an event asynchronously using `queueMicrotask`.
	 * This ensures the event is processed as soon as the current call stack clears,
	 * but before the next event loop iteration (macrotask).
	 *
	 * This is a "fire-and-forget" operation.
	 *
	 * @param event - The event name
	 * @param args - The event arguments
	 */
	emitAsync<K extends EventNames<T>>(event: K, ...args: T[K]): void {
		queueMicrotask(() => {
			this.emit(event, ...args);
		});
	}

	/**
	 * Queue an event to be emitted later when `flushDeferred()` is called.
	 * This allows buffering events to be processed in batches (e.g., at the end of a frame).
	 *
	 * @param event - The event name
	 * @param args - The event arguments
	 * @throws Error if the deferred queue size exceeds `maxDeferredEvents`
	 */
	emitDeferred<K extends EventNames<T>>(event: K, ...args: T[K]): void {
		if (this.#deferredQueue.length >= this.#maxDeferredEvents) {
			throw new Error(
				`[EventEmitter] Deferred queue overflow (max: ${this.#maxDeferredEvents})`,
			);
		}
		this.#deferredQueue.push(() => this.emit(event, ...args));
	}

	/**
	 * Synchronously flush all queued deferred events.
	 *
	 * - Events are processed in the order they were queued.
	 * - The queue is cleared *before* processing to safely handle re-entrancy
	 *   (events queued during flush will be processed in the next flush).
	 * - Errors in individual events are logged but do not stop the flush process.
	 */
	flushDeferred(): void {
		const queue = this.#deferredQueue;
		if (queue.length === 0) return;

		// Clear queue immediately to handle re-entrancy safe
		this.#deferredQueue = [];

		for (const task of queue) {
			try {
				task();
			} catch (error) {
				// Error isolation: log and continue
				console.error("[EventEmitter] Error in deferred dispatch:", error);
			}
		}
	}

	/**
	 * Invoke a listener with arguments.
	 * Uses direct call for 0-5 arguments to avoid Function.prototype.apply overhead.
	 */
	#invoke(listener: Listener, args: readonly unknown[]): void {
		const fn = listener.fn;
		const ctx = listener.context;
		const len = args.length;

		// Direct call optimization for common cases (0-5 arguments)
		// This avoids the overhead of Function.prototype.apply
		switch (len) {
			case 0:
				fn.call(ctx);
				return;
			case 1:
				fn.call(ctx, args[0]);
				return;
			case 2:
				fn.call(ctx, args[0], args[1]);
				return;
			case 3:
				fn.call(ctx, args[0], args[1], args[2]);
				return;
			case 4:
				fn.call(ctx, args[0], args[1], args[2], args[3]);
				return;
			case 5:
				fn.call(ctx, args[0], args[1], args[2], args[3], args[4]);
				return;
			default:
				// Fallback for 6+ arguments
				fn.apply(ctx, args as unknown[]);
		}
	}

	/**
	 * Get the number of listeners for an event.
	 *
	 * @param event - The event name
	 * @returns The number of listeners
	 */
	listenerCount<K extends EventNames<T>>(event: K): number {
		const store = this.#events[event];
		if (!store) return 0;
		if (isSingleListener(store)) return 1;
		return store.length;
	}

	/**
	 * Get all listeners for an event.
	 *
	 * @param event - The event name
	 * @returns Array of listener functions
	 */
	listeners<K extends EventNames<T>>(event: K): Array<EventListener<T, K>> {
		const store = this.#events[event];
		if (!store) return [];
		if (isSingleListener(store)) {
			return [store.fn as unknown as EventListener<T, K>];
		}
		return store.map((l) => l.fn as unknown as EventListener<T, K>);
	}

	/**
	 * Get all event names that have listeners.
	 *
	 * @returns Array of event names
	 */
	eventNames(): Array<EventNames<T>> {
		if (this.#eventCount === 0) return [];

		// Use Reflect.ownKeys to get both string and symbol keys
		return Reflect.ownKeys(this.#events) as Array<EventNames<T>>;
	}

	/**
	 * Remove all listeners for an event, or all listeners if no event specified.
	 *
	 * @param event - Optional event name. If omitted, removes all listeners.
	 * @returns this (for chaining)
	 */
	removeAllListeners<K extends EventNames<T>>(event?: K): this {
		if (event !== undefined) {
			if (this.#events[event]) {
				delete this.#events[event];
				this.#eventCount--;
			}
		} else {
			this.#events = createEventsObject();
			this.#eventCount = 0;
		}
		return this;
	}

	/**
	 * Alias for `on`.
	 *
	 * @param event - The event name
	 * @param fn - The listener function
	 * @param context - Optional context (`this` value) for the listener
	 * @returns this (for chaining)
	 */
	addListener<K extends EventNames<T>>(
		event: K,
		fn: EventListener<T, K>,
		context?: unknown,
	): this {
		return this.on(event, fn, context);
	}

	/**
	 * Alias for `off`.
	 *
	 * @param event - The event name
	 * @param fn - The listener function to remove
	 * @param options - Additional options for matching listeners
	 * @returns this (for chaining)
	 */
	removeListener<K extends EventNames<T>>(
		event: K,
		fn?: EventListener<T, K>,
		options?: RemoveListenerOptions,
	): this {
		return this.off(event, fn, options);
	}
}

/**
 * Utility type to define events with a schema-like syntax.
 * This extracts parameter types from function signatures.
 *
 * @example
 * ```typescript
 * const events = defineEvents({
 *   'pointer:down': (x: number, y: number) => {},
 *   'viewport:resize': (width: number, height: number, dpr: number) => {},
 *   'selection:change': (ids: Set<string>) => {},
 * });
 *
 * // Infers: {
 * //   'pointer:down': [x: number, y: number];
 * //   'viewport:resize': [width: number, height: number, dpr: number];
 * //   'selection:change': [ids: Set<string>];
 * // }
 * type MyEvents = typeof events;
 * ```
 */
export type DefineEvents<T extends Record<string, (...args: never[]) => void>> =
	{
		[K in keyof T]: Parameters<T[K]>;
	};

/**
 * Helper function to define events with type inference.
 * The actual runtime value is irrelevant; this is purely for type inference.
 *
 * @param _schema - Object with event handlers (only used for type inference)
 * @returns Type-only representation of the event map
 */
export function defineEvents<
	T extends Record<string, (...args: never[]) => void>,
>(_schema: T): DefineEvents<T> {
	// This function is purely for type inference
	// The return value is never used at runtime
	return undefined as unknown as DefineEvents<T>;
}

// Default export for convenience
export default TypedEventEmitter;
