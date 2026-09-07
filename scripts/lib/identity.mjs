/**
 * The permanent PPV protocol identities.
 *
 * These are not configuration. Every PPV account address derives from a program
 * id, so replacing one does not migrate anything — it creates a distinct
 * protocol universe in which every existing agreement, proof and PDA resolves
 * to nothing. They are duplicated here, deliberately, so a single source can be
 * compared against `declare_id!`, `Anchor.toml`, the built IDL, the permanent
 * keypairs and the chain, and any disagreement is a hard failure rather than a
 * value silently copied from whichever place was read first.
 */
export const PERMANENT_PROGRAM_IDS = Object.freeze({
  ppv_core: "9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU",
  ppv_commerce: "GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3",
});

export const PROGRAM_NAMES = Object.freeze(Object.keys(PERMANENT_PROGRAM_IDS));

/** The BPF upgradeable loader. A program owned by anything else is not one. */
export const UPGRADEABLE_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

/**
 * Minimum Squads threshold accepted as a final upgrade authority. Two is the
 * point at which no single compromised key can push a program upgrade.
 */
export const MIN_SQUADS_THRESHOLD = 2;

export const REQUIRED_TOOLCHAIN = Object.freeze({
  anchor: "0.30.1",
  solana: "1.18.17",
  rustHost: "1.85.1",
  rustAnchorBuild: "1.79.0",
  idlNightly: "nightly-2024-06-15",
  nodeMajor: 22,
});
