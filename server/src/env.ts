/**
 * Loads the repo-root .env before any other module reads process.env.
 * Must be the FIRST import in index.ts — places.ts and concierge.ts decide
 * their providers at module-init time. Uses Node 22's built-in loader (no
 * dotenv dep); already-set env vars (e.g. from docker-compose env_file or
 * Railway) take precedence over the file.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const p of [path.resolve(dir, "../../.env"), path.resolve(process.cwd(), ".env")]) {
  try {
    process.loadEnvFile(p);
    console.log(`loaded env from ${p}`);
    break;
  } catch { /* no .env there — fine, keys are optional */ }
}
