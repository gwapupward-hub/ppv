# Known risks — disclosed before review

An independent reviewer should not have to discover these. They are stated
here so review effort goes to what is *not* already known.

## Mandatory disclosures

1. **There is no on-chain Commerce ↔ Escrow binding.** No CPI, no stored
   program ID, no cross-program PDA, no referencing field. Any link between a
   negotiated Commerce agreement and an escrowed `EscrowAgreement` is off-chain
   convention. (RR-4)
2. **Classic SPL Token is the current security claim.** Every custody account is
   typed `Program<Token>` / `Account<TokenAccount>`.
3. **Token-2022 is outside the current security claim.** Not partially
   supported — rejected at the type boundary. Transfer-fee and transfer-hook
   extensions would break "the vault received exactly the agreed amount", and
   `spl-token-2022 v3` conflicts with this workspace's `solana-program` pin.
4. **One devnet Escrow custody signer overlaps Core/Commerce governance.**
   `BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ`, one of three, in a 2-of-3.
   One shared signer cannot reach the threshold alone; a second would end that
   property.
5. **That shared-signer exception is devnet-only**
   (`sharedSignerExceptionScope: "devnet"`), never a default, and the verifier
   refuses the member set unless `--allow-shared-signers` is passed.
6. **Legal review remains OPEN.**
7. **Mainnet is NOT authorized.** The custody gate is CLOSED.

## Residual risk register — open entries

Full text in `docs/security/ppv-escrow-residual-risk.md`.

| Id | Risk | State |
| --- | --- | --- |
| RR-2 | Milestone state does not mean what a reader assumes | OPEN |
| RR-3 | Donated surplus is stranded | OPEN |
| RR-4 | Escrow has no binding to Commerce | OPEN (architectural) |
| RR-5 | True concurrency is not simulated | OPEN |
| RR-7 | Squads threshold declared, not read from chain | CLOSED for custody multisig; **NARROWED to Core/Commerce** |
| RR-9 | `Invoice`, `Contract`, `ProofOnly` unimplemented | OPEN (refused at init) |
| RR-10 | Dispute resolution is concession-only | OPEN (deliberate) |
| RR-13 | No independent security review | **OPEN — this package** |

Closed: RR-1, RR-6, RR-8, RR-11, RR-12.

## RR-3 in detail, because it is a custody fact

Payout amounts derive from `agreement` fields (`remaining()`,
`milestone.amount`), never from `vault.amount`. So:

* Tokens transferred directly into a vault are **not** funding (Invariant 10 —
  this is a deliberate defence).
* Those tokens are also never paid out. After a terminal state they remain in
  the vault permanently.
* **No instruction closes a vault or an agreement.** The vault's rent-exempt
  lamports are likewise permanent.

This is a griefing/dust condition, not a theft condition: the surplus is
unreachable by everyone, including the attacker who donated it. There is no
recovery instruction and adding one would create a new authority.

## Verification the team could not perform

**Upstream version currency and advisory status were not verified.** This
environment's network egress is scoped to the project repository, so
crates.io, the Anchor and Agave release feeds, and RustSec were unreachable.

Every version in [08-deployment-governance](08-deployment-governance.md) was
read from this repository's own lockfiles and evidence records. Whether
`solana-program 1.18.17`, `anchor-lang 0.30.1`, `spl-token 4.0.3`,
`borsh 0.9.3`, `@solana/web3.js 1.95.8` or `@sqds/multisig 2.1.4` carries a
published advisory at review time is **an open question for the reviewer**, and
is item 1 on the [auditor checklist](10-auditor-checklist.md).

No upgrade was performed. The pins are load-bearing and documented; changing
them is a migration decision with its own compatibility and rollback analysis,
not a hygiene step.
