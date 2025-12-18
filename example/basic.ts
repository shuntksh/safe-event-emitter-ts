import { TypedEventEmitter } from "../src/event-emitter.ts";

// Example usage:
type MyEvents = {
	"user:login": [user: { id: string; name: string }]; // Named tuple element for better docs
	"user:logout": [user: { id: string }];
	message: [message: { text: string; from: string }];
};

const emitter = new TypedEventEmitter<MyEvents>();

// Type-safe event handling
emitter.on("user:login", (user) => {
	// TypeScript knows that user has { id: string; name: string }
	console.log(`User ${user.name} logged in`);
});

emitter.on("message", (message) => {
	// TypeScript knows that message has { text: string; from: string }
	console.log(`${message.from}: ${message.text}`);
});

// Type-safe event emission
emitter.emit("user:login", { id: "123", name: "John" }); // ✅ OK
emitter.emit("message", { text: "Hello", from: "John" }); // ✅ OK

console.log("Example finished successfully!");

// Type errors (commented out to allow running):
// emitter.emit("user:login", { id: "123" }); // ❌ Error: missing 'name' property
// emitter.emit("unknown-event", {}); // ❌ Error: unknown event
// emitter.on("user:logout", (user) => {
// 	console.log(user.name); // ❌ Error: 'name' doesn't exist on type '{ id: string }'
// });
