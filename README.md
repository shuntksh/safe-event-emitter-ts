# safe-event-emitter-ts

A high-performance, fully type-safe EventEmitter implementation for TypeScript with an API similar to Node.js EventEmitter.

## Features

- 🔒 **End-to-End Type Safety**: Events, argument tuples, and listeners are partially inferred and strictly checked.
- 🚀 **High Performance**: Optimized for speed with single-listener optimization and no closures/bind overhead.
- ⚡ **Async Support**: Native support for `emitAsync` (microtask) and `emitDeferred` (buffered).
- 🔄 **Node.js Compatible**: Implements core `on`, `off`, `emit`, `once` API.
- 🌐 **Cross-Platform**: Works in Browser, Node.js, and Bun with zero dependencies.
- 📦 **Tiny**: Minimal footprint, no external dependencies.

## Installation

```bash
# Using bun
bun add safe-event-emitter-ts

# Using npm
npm install safe-event-emitter-ts
```

## Basic Usage

```typescript
import { TypedEventEmitter } from 'safe-event-emitter-ts';

// 1. Define your event map (Event Name -> Argument Tuple)
type MyEvents = {
  'user:login': [username: string, timestamp: number];
  'user:logout': [username: string];
  'message': [text: string, from: string];
  'error': [error: Error];
};

// 2. Create the emitter
const emitter = new TypedEventEmitter<MyEvents>();

// 3. Add listeners (fully typed arguments)
emitter.on('user:login', (username, timestamp) => {
  console.log(`${username} logged in at ${timestamp}`);
});

emitter.on('message', (text, from) => {
  console.log(`${from}: ${text}`);
});

// 4. Emit events (type checked)
emitter.emit('user:login', 'Alice', Date.now()); // ✅ Valid
emitter.emit('message', 'Hello!', 'Bob');        // ✅ Valid

// Compiler Errors:
// emitter.emit('user:login', 'Alice');          // ❌ Missing timestamp
// emitter.emit('unknown', 123);                 // ❌ Unknown event
```

## Advanced Usage

### Async Events (`emitAsync`)

Fire-and-forget asynchronous emission using `queueMicrotask`. Listeners run after the current call stack clears.

```typescript
emitter.on('data', (data) => console.log('Processed:', data));

console.log('Start');
emitter.emitAsync('data', { id: 1 });
console.log('End');

// Output:
// Start
// End
// Processed: { id: 1 }
```

### Deferred Events (`emitDeferred` & `flushDeferred`)

Buffer events to be processed later (e.g., essentially useful for game loops, batch processing, or UI rendering phases).

```typescript
// Configure max buffer size (default: 10000)
const gameEvents = new TypedEventEmitter<GameEvents>({ maxDeferredEvents: 500 });

// Queue events
gameEvents.emitDeferred('player:move', { x: 10, y: 20 });
gameEvents.emitDeferred('player:jump', { height: 5 });

// Processing happens ONLY when flushed
requestAnimationFrame(() => {
  gameEvents.flushDeferred(); // Dispatches all queued events
});
```

### One-Time Listeners

```typescript
emitter.once('init', () => {
  console.log('Initialized!');
});
```

### Context Binding

Avoid creating closures or using `.bind()`. Pass the context directly for better performance.

```typescript
class Game {
  start() {
    // 'this' is passed as the 3rd argument and used as context
    emitter.on('start', this.onStart, this);
  }

  onStart() {
    console.log(this); // Correctly typed as Game instance
  }
}
```

## API Reference

### `class TypedEventEmitter<T>`

#### Methods

- **`on(event, fn, context?)`**: Add a listener.
- **`once(event, fn, context?)`**: Add a one-time listener.
- **`off(event, fn?, context?)`**: Remove a listener. If `fn` is omitted, removes all for that event.
- **`emit(event, ...args)`**: Synchronously call listeners. Returns `true` if listeners existed.
- **`emitAsync(event, ...args)`**: Asynchronously call listeners (microtask).
- **`emitDeferred(event, ...args)`**: Queue event for manual flushing.
- **`flushDeferred()`**: Synchronously process all queued events.
- **`removeAllListeners(event?)`**: Clear all listeners (or specific event).
- **`listenerCount(event)`**: Get count of listeners.
- **`eventNames()`**: Get list of active event names.

## License

MIT
