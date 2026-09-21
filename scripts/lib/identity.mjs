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
  ppv_escrow: "7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4",
});

export const PROGRAM_NAMES = Object.freeze(Object.keys(PERMANENT_PROGRAM_IDS));

/**
 * Programs whose devnet deployment is complete.
 *
 * Deliberately not the same list as `PERMANENT_PROGRAM_IDS`. That table says a
 * program has a permanent identity; this one says the identity is occupied on
 * devnet. They were identical until the `ppv_escrow` freeze, and every on-chain
 * check quietly took the identity table to mean "deployed" — so the moment
 * escrow gained an identity, the smoke suite began demanding an account that
 * must not exist.
 *
 * Membership here is a claim about the chain, never a way to quiet a failing
 * check — and it now carries a second duty. An address on this list has had its
 * one initial deployment, so the initial-deployment workflow must refuse it.
 * That refusal used to rest solely on a committed evidence record, which is
 * exactly what `ppv_escrow` did not have when its recorder crashed after a
 * successful deploy: for a window, the repository still believed the address
 * was free. Listing it closes that window without depending on an RPC call or
 * on a file that failed to be written.
 */
export const DEVNET_DEPLOYED_PROGRAMS = Object.freeze([
  "ppv_core",
  "ppv_commerce",
  // Deployed 2026-09-15 by workflow run 34940712181: program deployed, upgrade
  // authority transferred to the custody vault, and the run's own JSON-RPC read
  // confirmed the authority, `executable` and the upgradeable-loader owner
  // before its evidence step failed. Listed here because it is occupied — which
  // is also what makes the initial-deployment path refuse it.
  "ppv_escrow",
]);

/**
 * Workspace programs that deliberately have no permanent id yet.
 *
 * Empty since the `ppv_escrow` identity freeze. It stays exported, and
 * `scripts/test/escrow-identity.test.mjs` keeps asserting that every directory
 * under `programs/` appears in this list or in `PERMANENT_PROGRAM_IDS`, so
 * adding a fourth program fails until someone decides which list it belongs in
 * — silence is how a program ends up deployed with an id nothing checks.
 */
export const UNRELEASED_PROGRAMS = Object.freeze([]);

/**
 * The permanent `ppv_escrow` identity. Frozen — do not regenerate.
 *
 * Every PPV account address derives from a program id, so replacing this does
 * not migrate anything: it creates a distinct protocol universe in which every
 * existing agreement, proof and PDA resolves to nothing. The build-only id in
 * `ESCROW_PLACEHOLDER_ID` is not this and must never be recorded as if it were.
 *
 * Setting this was the identity freeze. Every check in
 * `scripts/test/escrow-identity.test.mjs` switched from "escrow is unreleased
 * everywhere" to "every source names exactly this id", so the transition could
 * not be half-entered in either direction.
 */
export const ESCROW_PERMANENT_ID = "7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4";

/** The build-only id `ppv_escrow` carries until the ceremony replaces it. */
export const ESCROW_PLACEHOLDER_ID = "7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR";

/**
 * The custody governance `ppv_escrow` will be released under.
 *
 * A dedicated Squads V4 2-of-3 on devnet, separate from the multisig governing
 * the non-custodial programs, created by
 * `scripts/create-escrow-custody-multisig.mjs`. This is the single record every
 * release and deployment gate reads, so that "the custody multisig" means one
 * address everywhere rather than whatever each check was configured with.
 *
 * `vault` is the live upgrade authority for the deployed `ppv_escrow`, and
 * holding that authority is not the same as being cleared to use it: the
 * custody gate in `docs/deployment-gates.md` stays closed on its remaining
 * requirements, RR-13 and legal review among them.
 */
export const ESCROW_CUSTODY_GOVERNANCE = Object.freeze({
  /** The Squads V4 multisig account created for Escrow custody, on devnet. */
  multisig: "GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46",
  /**
   * Vault index 0, and the upgrade authority `ppv_escrow` is deployed under.
   *
   * Historical note: before the Sprint 4 deployment on 2026-09-15 this field
   * was the *intended future* authority and said so. It is now live.
   * `deployments/evidence/ppv-escrow-devnet-231dceb.json` records the
   * deployment at slot 498656161 and the authority transfer to this address at
   * slot 498656235, both finalized, and carries it as its `upgradeAuthority`.
   *
   * The address is deliberately not repeated in this comment. The freeze
   * tamper suite mutates the first occurrence of the vault address in this
   * file, so a copy sitting above the constant would absorb the mutation and
   * leave the real one intact — a comment silently blunting a security test.
   *
   * Recording it here is what lets every gate check the same destination
   * rather than whatever each check was configured with.
   */
  vault: "FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE",
  threshold: 2,
  members: Object.freeze([
    "HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx",
    "5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo",
    "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
  ]),
  /** Permissions every member holds: Initiate + Vote + Execute (Squads mask 7). */
  permissionMask: 7,
  timeLock: 0,
  vaultIndex: 0,
  network: "devnet",
  creationTx:
    "PAr6UEy3Am4HDjZFLwWKCiG3jVMh2pE9vCfKxAq3SACyFs9wwheGCwLDRV57kE7GHZPyCJEqQBJByR1574spqR5",
  /**
   * The one signer this multisig shares with Core/Commerce governance.
   *
   * Recorded as data rather than described in prose so the count can be
   * asserted. One shared signer cannot reach a 2-of-3 threshold alone, which is
   * the whole reason this is tolerable; a second would end that property. The
   * exception is scoped to devnet and is never a default — the verifier still
   * refuses this member set unless `--allow-shared-signers` is passed.
   */
  sharedSignersWithNonCustody: Object.freeze(["BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ"]),
  sharedSignerExceptionScope: "devnet",
});

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
