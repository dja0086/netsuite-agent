import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/** Where the M2M private key comes from. Production uses a real secrets manager adapter. */
export interface SecretsBackend {
  /** Returns the secret's value. Implementations must never log it. */
  get(name: SecretName): Promise<string>;
}

export type SecretName = "netsuite/m2m-private-key";

/** Walks up from `start` to the folder holding pnpm-workspace.yaml (the repo root), if any. */
function findRepoRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Local development backend: reads the key from a file OUTSIDE the repository.
 * Refuses keys stored inside the repo so they cannot be committed by accident.
 */
export class FileSecretsBackend implements SecretsBackend {
  constructor(
    private readonly keyPath: string,
    private readonly cwd: string = process.cwd(),
  ) {}

  async get(name: SecretName): Promise<string> {
    if (name !== "netsuite/m2m-private-key") throw new Error(`Unknown secret ${name}`);
    const resolved = path.resolve(this.keyPath);
    const repoRoot = findRepoRoot(this.cwd);
    if (repoRoot && (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep))) {
      throw new Error("Refusing to read a private key stored inside the repository. Move it outside the repo.");
    }
    const info = await stat(resolved);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      // Group/other readable keys are a common leak path; warn without failing local dev.
      process.stderr.write(`[ns-client] warning: ${resolved} is readable by other users; run chmod 600\n`);
    }
    return readFile(resolved, "utf8");
  }
}

export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): SecretsBackend {
  const backend = (env.SECRETS_BACKEND ?? "file").trim();
  switch (backend) {
    case "file": {
      const keyPath = env.NS_PRIVATE_KEY_PATH?.trim();
      if (!keyPath) throw new Error("SECRETS_BACKEND=file requires NS_PRIVATE_KEY_PATH (a path outside the repo)");
      return new FileSecretsBackend(keyPath);
    }
    default:
      // [FILL: production secrets backend] Add an adapter here (for example a cloud secrets manager).
      throw new Error(`Unsupported SECRETS_BACKEND "${backend}". Add an adapter in packages/ns-client/src/secrets.ts`);
  }
}
