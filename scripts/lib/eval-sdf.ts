import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A throwaway SDF src folder (the repo's manifest.xml and an empty Objects/) for NS_AGENT_SDF_DIR, so evals that
 * call ns_field_generate never write into netsuite/src.
 */
export async function tempSdfProject(repoRoot: string, parent?: string): Promise<string> {
  const dir = path.join(parent ?? (await mkdtemp(path.join(tmpdir(), "ns-agent-sdf-"))), "sdf-src");
  await mkdir(path.join(dir, "Objects"), { recursive: true });
  await copyFile(path.join(repoRoot, "netsuite/src/manifest.xml"), path.join(dir, "manifest.xml"));
  return dir;
}
