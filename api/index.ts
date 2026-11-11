/**
 * Vercel entry point.
 *
 * The same Express app the local server runs, mounted as one serverless function.
 * Two deployment-specific differences:
 *
 *  - The database lives in `/tmp`, the only writable path in a serverless
 *    environment. That makes durability best-effort: within a warm instance the
 *    file persists, across cold starts it does not. The local `npm run dev` keeps
 *    the durable file-backed behaviour.
 *  - SSE replies are produced by the same handlers; the platform may buffer them,
 *    which the client already tolerates because it parses whole frames rather than
 *    relying on chunk boundaries.
 */
import { app } from "../src/server/index.js";

export default app;
