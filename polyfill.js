// WebCrypto global for Better Auth on runtimes that don't expose it (Node <20).
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
