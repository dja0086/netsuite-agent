import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SdfSpecError, withRequiredFeatures, type SdfArtifact } from "@ns-agent/sdf-gen";
import { ToolInputError } from "../registry";

/* Writing generated SDF objects into the SuiteCloud project on the gateway host (custom-fields, pdf-templates). */

/** The SDF project's src folder (holds manifest.xml and Objects/); NS_AGENT_SDF_DIR overrides the repo default. */
const sdfOverride = () => process.env.NS_AGENT_SDF_DIR?.trim();
export const sdfDir = () => sdfOverride() || path.resolve("netsuite/src");

export async function projectRoot(): Promise<string> {
  let root: string;
  try {
    root = await realpath(sdfDir());
    await stat(path.join(root, "manifest.xml"));
  } catch {
    throw new ToolInputError(`the SDF project folder ${sdfDir()} has no manifest.xml (NS_AGENT_SDF_DIR)`);
  }
  // The repo default must be the real folder: a symlinked netsuite/ or netsuite/src committed to the repo must not
  // redirect writes. An explicit NS_AGENT_SDF_DIR is the operator's choice and may resolve elsewhere.
  if (!sdfOverride() && root !== path.resolve("netsuite/src")) {
    throw new ToolInputError(`refusing to write: netsuite/src resolves to ${root} (symbolic link)`);
  }
  return root;
}

/** Resolves an artifact path under Objects/, refusing anything that would land outside it. */
export function objectPath(root: string, rel: string): string {
  const objects = path.join(root, "Objects");
  const full = path.resolve(objects, rel);
  if (!full.startsWith(objects + path.sep)) throw new ToolInputError(`refusing to write outside ${objects}`);
  return full;
}

export const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** Writes a file without following a symbolic link at its path (O_NOFOLLOW closes the gap after the checks). */
export async function writeNoFollow(file: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new ToolInputError(`refusing to write through a symbolic link: ${file}`);
    throw error;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

/** Refuses a symlink at `file`: a write would follow it out of the project. */
export async function refuseSymlink(file: string): Promise<void> {
  const info = await lstat(file).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new ToolInputError(`refusing to write through a symbolic link: ${file}`);
}

/**
 * Creates the target's folder and checks that, with symlinks resolved, it is still inside Objects/ (a symlinked
 * Objects/ or fields/ folder committed to the repo must not redirect the write).
 */
async function safeTarget(root: string, rel: string): Promise<string> {
  const full = objectPath(root, rel);
  const objects = path.join(root, "Objects");
  // Each folder is checked before anything is created inside it (root is already realpath'd).
  for (const dir of [objects, path.dirname(full)]) {
    await refuseSymlink(dir);
    await mkdir(dir, { recursive: true });
    if ((await realpath(dir)) !== dir) throw new ToolInputError(`refusing to write outside ${objects} (symbolic link in the path)`);
  }
  await refuseSymlink(full);
  return full;
}

/**
 * Writes an artifact's files under Objects/ and adds the manifest features it needs. Callers make their own refusals
 * (overwrite, script ID checks) first.
 */
export async function writeArtifact(artifact: SdfArtifact): Promise<{ written: string[]; manifestFeaturesAdded: string[] }> {
  const root = await projectRoot();
  // Everything that can be refused is checked before the first write, so a refusal never leaves a file behind.
  const manifestPath = path.join(root, "manifest.xml");
  await refuseSymlink(manifestPath);
  const before = await readFile(manifestPath, "utf8");
  let after: string;
  try {
    after = withRequiredFeatures(before, artifact.features);
  } catch (error) {
    if (error instanceof SdfSpecError) throw new ToolInputError(`manifest.xml: ${error.message}`);
    throw error;
  }
  const targets = await Promise.all(artifact.files.map(async (f) => ({ f, full: await safeTarget(root, f.path) })));
  const written: string[] = [];
  for (const { f, full } of targets) {
    await writeNoFollow(full, f.content);
    written.push(`Objects/${f.path}`);
  }
  const manifestFeaturesAdded = artifact.features.filter((f) => !new RegExp(`<feature required="true">${f}</feature>`).test(before));
  if (after !== before) {
    await writeNoFollow(manifestPath, after);
    written.push("manifest.xml");
  }
  return { written, manifestFeaturesAdded };
}
