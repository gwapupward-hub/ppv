#!/usr/bin/env bash
set -euo pipefail

# Mutation qualification for the PPV Escrow security suite.
#
# A green security suite proves nothing on its own: a suite that asserts
# whatever the code happens to do is green by construction. This script asks
# the only question that matters about it — would it notice if the program were
# wrong — by breaking one defence at a time and requiring the suite to fail.
#
# Each mutation is a single textual substitution in the program, chosen to be a
# defect a real change could plausibly introduce rather than a nonsense edit.
# Every mutation is reverted before the next one runs, and the script refuses to
# finish unless the working tree is exactly as it started.
#
#   ./scripts/mutation-qualify.sh            # all mutations
#   ./scripts/mutation-qualify.sh custody    # one, by id
#
# Exit status is the verdict: 0 when every mutation was detected.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

AGREEMENT="programs/ppv_escrow/src/state/agreement.rs"
ENUMS="programs/ppv_escrow/src/state/enums.rs"
PROOF="programs/ppv_escrow/src/state/proof.rs"

if ! git diff --quiet -- "${AGREEMENT}" "${ENUMS}" "${PROOF}"; then
  echo "The files this script mutates already have uncommitted changes." >&2
  echo "Commit or stash them first: a mutation run must start from a known tree." >&2
  exit 1
fi

# Each mutation is applied with `python3`, which does exact literal replacement
# and fails loudly when the anchor text is missing or ambiguous — a mutation
# that silently did not apply would look like a suite that failed to detect it.
apply_mutation() {
  local id="$1"
  python3 - "${id}" <<'PY'
import sys, pathlib

AGREEMENT = pathlib.Path("programs/ppv_escrow/src/state/agreement.rs")
ENUMS = pathlib.Path("programs/ppv_escrow/src/state/enums.rs")
PROOF = pathlib.Path("programs/ppv_escrow/src/state/proof.rs")

# id -> (file, old, new)
MUTATIONS = {
    # Authorization: anyone at all may open a dispute over someone else's money.
    "authorization": (
        AGREEMENT,
        """        require!(self.is_party(signer), EscrowError::NotAParty);
        require!(
            matches!(
                self.state,
                AgreementState::Funded | AgreementState::Completed
            ),
            EscrowError::BadState
        );
        Ok(())
    }

    pub fn record_disputed""",
        """        require!(
            matches!(
                self.state,
                AgreementState::Funded | AgreementState::Completed
            ),
            EscrowError::BadState
        );
        Ok(())
    }

    pub fn record_disputed""",
    ),
    # Custody: the vault may pay out more than it ever took in.
    "custody": (
        AGREEMENT,
        "        require!(total <= self.amount, EscrowError::CustodyMismatch);\n        self.settled_total = total;",
        "        self.settled_total = total;",
    ),
    # Destination binding: a party may concede a dispute to itself, which is
    # simply taking the money.
    "destination": (
        AGREEMENT,
        "        require!(signer != beneficiary, EscrowError::CannotConcedeToSelf);",
        "",
    ),
    # Terminal finality: a settled agreement stops reporting itself as ended.
    "terminal": (
        ENUMS,
        "            AgreementState::Settled | AgreementState::Cancelled | AgreementState::Refunded",
        "            AgreementState::Cancelled | AgreementState::Refunded",
    ),
    # Identity: the unassigned payee field makes the default address a party —
    # the defect this sprint found, kept as a permanent mutation so the suite
    # cannot lose the ability to detect it.
    "identity": (
        AGREEMENT,
        "        if *signer == Pubkey::default() {\n            return false;\n        }\n",
        "",
    ),
    # Milestone allocation: a schedule may promise more than the escrow holds.
    "milestone": (
        AGREEMENT,
        "        require!(total <= self.amount, EscrowError::MilestoneTotalMismatch);",
        "",
    ),
    # Cross-program evidence validity (RR13-001): a settlement may cite a
    # ppv_core commitment its own author has revoked. This is the finding
    # itself, kept as a permanent mutation so the suite cannot lose the ability
    # to detect it.
    "core-revocation": (
        PROOF,
        """        require!(
            core.status == CoreProofStatus::Active,
            EscrowError::CoreProofRevoked
        );
        Ok(())""",
        """        Ok(())""",
    ),
    # The same guard inverted rather than deleted — a defect a careless edit
    # produces far more easily than a deletion, and one that a suite testing
    # only the rejection path would pass.
    "core-revocation-inverted": (
        PROOF,
        "            core.status == CoreProofStatus::Active,",
        "            core.status != CoreProofStatus::Active,",
    ),
    # Account substitution: the status is read off whatever core record the
    # caller passed, because nothing binds it to this piece of evidence. A
    # live record of another proof would then satisfy the check above.
    "core-proof-binding": (
        PROOF,
        """        require_keys_eq!(core.key, self.core_proof, EscrowError::CoreProofMismatch);

        let (derived, _) = core_proof_address(&self.submitter, &self.agreement, self.proof_index);
        require_keys_eq!(core.key, derived, EscrowError::CoreProofMismatch);
        require_keys_eq!(
            core.authority,
            self.submitter,
            EscrowError::CoreProofMismatch
        );
""",
        "",
    ),
    # State machine: settlement no longer requires completion.
    "state-machine": (
        AGREEMENT,
        """        require!(
            self.state == AgreementState::Completed,
            EscrowError::BadState
        );
        Ok(())
    }""",
        """        Ok(())
    }""",
    ),
}

mutation_id = sys.argv[1]
path, old, new = MUTATIONS[mutation_id]
text = path.read_text()
count = text.count(old)
if count != 1:
    sys.stderr.write(f"mutation {mutation_id}: anchor matched {count} times, expected 1\n")
    sys.exit(2)
path.write_text(text.replace(old, new, 1))
PY
}

ALL_IDS=(authorization custody destination terminal identity milestone state-machine \
  core-revocation core-revocation-inverted core-proof-binding)
declare -A CLASS=(
  [authorization]="authorization"
  [custody]="custody conservation"
  [destination]="destination binding"
  [terminal]="terminal finality"
  [identity]="party identity / cross-program binding"
  [milestone]="milestone allocation"
  [state-machine]="state-machine legality"
  [core-revocation]="cross-program evidence validity (RR13-001)"
  [core-revocation-inverted]="cross-program evidence validity (RR13-001)"
  [core-proof-binding]="cross-program account binding (RR13-001)"
)
declare -A DESCRIPTION=(
  [authorization]="any signer may open a dispute over an agreement it is not party to"
  [custody]="settled_total may exceed the funded amount"
  [destination]="a disputing party may concede to itself"
  [terminal]="Settled no longer reports itself terminal"
  [identity]="the default address counts as a party when no payee is assigned"
  [milestone]="a milestone schedule may promise more than the escrow holds"
  [state-machine]="settlement no longer requires Completed"
  [core-revocation]="a settlement may cite a revoked ppv_core commitment"
  [core-revocation-inverted]="only a revoked ppv_core commitment may back a payout"
  [core-proof-binding]="any ppv_core record may stand in for this proof's commitment"
)

requested=("$@")
if [[ ${#requested[@]} -eq 0 ]]; then
  requested=("${ALL_IDS[@]}")
fi

restore() {
  git checkout -- "${AGREEMENT}" "${ENUMS}" "${PROOF}"
}
trap restore EXIT

undetected=()
echo "PPV Escrow mutation qualification"
echo "  suite: cargo test -p ppv_escrow --locked"
echo

for id in "${requested[@]}"; do
  printf '  %-14s %s\n' "${id}" "${DESCRIPTION[${id}]:-unknown mutation}"
  apply_mutation "${id}"

  # A mutation that does not compile proves nothing about the tests, so build
  # failure is a broken mutation rather than a detection.
  if ! cargo test -p ppv_escrow --locked --no-run >/dev/null 2>&1; then
    echo "                 MUTATION DID NOT COMPILE — not a qualification" >&2
    undetected+=("${id} (did not compile)")
    restore
    continue
  fi

  if cargo test -p ppv_escrow --locked >/dev/null 2>&1; then
    printf '                 UNDETECTED — the suite passed a broken program\n'
    undetected+=("${id}")
  else
    # `pipefail` is on and this cargo run is *expected* to fail, so the
    # pipeline's status is the mutation working, not an error to abort on.
    detected=$(cargo test -p ppv_escrow --locked 2>&1 \
      | grep -E '^\s+state::|^\s+events::' | head -3 \
      | sed 's/^[[:space:]]*/                   /' || true)
    printf '                 detected [%s]\n%s\n' "${CLASS[${id}]}" "${detected}"
  fi
  restore
done

echo
if [[ ${#undetected[@]} -gt 0 ]]; then
  echo "MUTATION QUALIFICATION FAILED — undetected: ${undetected[*]}" >&2
  exit 1
fi
echo "MUTATION_QUALIFICATION_PASSED (${#requested[@]} mutations, all detected)"
