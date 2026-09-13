# Release records

One JSON file per released program per cluster. A record is the canonical,
public statement of what is deployed: which source, which bytes, which
authority, and which transactions put it there.

`scripts/verify-deployed-program.mjs <record>` checks a record against live
chain state. It needs an RPC endpoint and nothing else — no wallet, no default
signer, no keypair, no Solana CLI — so anyone can re-verify a release at any
time, including after everyone who ran the deployment has lost their keys. That
property is the whole point: a release only one person can check is not evidence.

These records are also load-bearing, not just descriptive:

- `.github/workflows/deploy-devnet.yml` refuses to run its initial deployment
  for any program that has one, before it reads the chain at all.
- `scripts/verify-devnet-readiness.sh` treats a released program's address as
  correctly occupied instead of as a blocker.
- `scripts/devnet-smoke.mjs` demands exactly the recorded programs on chain.

## Rules

- **Public only.** Addresses, hashes, slots, signatures and public keys. Never a
  private key, a seed phrase, or an RPC URL with an embedded credential.
- **Written from the chain, not from intent.** `scripts/collect-deployment-evidence.mjs`
  reads live state and refuses to write a record whose rebuilt binary is not
  byte-identical to what the loader is holding.
- **Never edited to match reality.** If the chain stops matching a record, that
  is the finding. Investigate it; do not adjust the record until the change is
  understood and its own transaction is recorded.
- **`binaryLength` is part of the evidence.** The loader allocates ProgramData
  larger than the program it holds, so verification compares exactly that many
  bytes and separately proves the remainder is zero padding — rather than
  trimming trailing bytes and hoping the result means something.
