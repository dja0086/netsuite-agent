import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Role tiers from roles/tiers.json (the one place NetSuite agent permissions are managed): each tier is one
 * NetSuite role, one sign-in and one vault, shared by every agent that picks it.
 */
const Tier = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string(),
  description: z.string(),
  role: z.string(),
  roleName: z.string(),
  writeTools: z.array(z.string()),
  vault: z.string().regex(/^vlt_[A-Za-z0-9]+$/).nullable(),
});
export type Tier = z.infer<typeof Tier>;

const here = path.dirname(fileURLToPath(import.meta.url));
const TIERS_FILE = path.resolve(here, "../../../roles/tiers.json");

export const TIERS: readonly Tier[] = z.object({ tiers: z.array(Tier).min(1) }).parse(JSON.parse(readFileSync(TIERS_FILE, "utf8"))).tiers;
export const TIER_IDS = TIERS.map((t) => t.id) as [string, ...string[]];

/** Agents created before tiers existed ran on the Clerk sign-in; they keep it until edited. */
export const LEGACY_TIER = "clerk";

export function tierById(id: string): Tier | undefined {
  return TIERS.find((t) => t.id === id);
}

/** The vault holding a tier's NetSuite sign-in, or an error saying the sign-in is still missing. */
export function vaultFor(tierId: string): string {
  const tier = tierById(tierId);
  if (!tier) throw new Error(`Unknown role tier "${tierId}".`);
  if (!tier.vault) throw new Error(`The ${tier.label} tier has no NetSuite sign-in yet (roles/tiers.json, docs/agent-builder.md "Role tiers").`);
  return tier.vault;
}
