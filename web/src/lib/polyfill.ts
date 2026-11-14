import { Buffer } from "buffer";

// NEAR libraries serialise call arguments with Buffer, which browsers lack. Imported first by main.tsx.
(globalThis as any).Buffer ??= Buffer;
