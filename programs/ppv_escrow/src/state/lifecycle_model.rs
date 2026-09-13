//! An exhaustive, independent model of who may do what, and when.
//!
//! Every `require_*` on `EscrowAgreement` answers two questions — *is this
//! signer allowed* and *is this legal now* — and each answers them with its own
//! short list of conditions. Read one at a time they are all obviously right.
//! The gap Sprint 3 found was not inside any one of them; it was between them:
//! `require_settleable` asked whether a payee existed and `require_disputable`
//! did not, and nothing in the file made that difference visible.
//!
//! So this module states the rules once, from the protocol's intent rather than
//! from the implementation, and then walks every reachable configuration of
//! (type, state, payee assigned) against every actor and every guard. A
//! divergence is reported as a table row naming the guard, the configuration,
//! the actor, what the model expected and what the code did.
//!
//! What this proves and what it does not: this is the authorization and state
//! layer only. It runs on the host with no validator, so it says nothing about
//! token movement, account substitution, or CPI. Those are the property suite's
//! job (`tests/invariants/`), and the two are deliberately different levels —
//! this one is exhaustive and cheap, that one is randomized and expensive.

#![cfg(test)]

use anchor_lang::prelude::*;

use crate::state::agreement::{EscrowAgreement, AGREEMENT_SCHEMA_VERSION};
use crate::state::enums::{AgreementState, AgreementType};

/// Every state an agreement account can hold.
const STATES: [AgreementState; 7] = [
    AgreementState::Open,
    AgreementState::Funded,
    AgreementState::Completed,
    AgreementState::Settled,
    AgreementState::Cancelled,
    AgreementState::Disputed,
    AgreementState::Refunded,
];

/// Every type `initialize_agreement` accepts. The reserved variants cannot be
/// created, so an agreement can never hold one.
const TYPES: [AgreementType; 3] = [
    AgreementType::Escrow,
    AgreementType::MilestoneContract,
    AgreementType::Bounty,
];

/// Who signs. These are roles, not addresses: `Payee` is only meaningful when
/// a payee exists, which is what `Config::payee_assigned` decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Creator,
    Payee,
    Outsider,
    /// The default address. Nothing can sign for it, but it can own a token
    /// account, so it can be *named* as a destination — which is how the
    /// unclaimed-bounty dead end was reachable.
    Nobody,
}

const ROLES: [Role; 4] = [Role::Creator, Role::Payee, Role::Outsider, Role::Nobody];

/// One reachable shape of an agreement account.
#[derive(Clone, Copy, Debug)]
struct Config {
    agreement_type: AgreementType,
    state: AgreementState,
    payee_assigned: bool,
}

impl Config {
    /// Only a bounty may exist without a payee, and only before one is named.
    /// Every other combination of the three axes is reachable.
    fn is_reachable(&self) -> bool {
        self.payee_assigned || self.agreement_type == AgreementType::Bounty
    }

    fn label(&self) -> String {
        format!(
            "{:?}/{:?}/{}",
            self.agreement_type,
            self.state,
            if self.payee_assigned {
                "payee"
            } else {
                "no-payee"
            }
        )
    }
}

struct World {
    creator: Pubkey,
    payee: Pubkey,
    outsider: Pubkey,
}

impl World {
    fn new() -> Self {
        Self {
            creator: Pubkey::new_unique(),
            payee: Pubkey::new_unique(),
            outsider: Pubkey::new_unique(),
        }
    }

    fn address(&self, role: Role) -> Pubkey {
        match role {
            Role::Creator => self.creator,
            Role::Payee => self.payee,
            Role::Outsider => self.outsider,
            Role::Nobody => Pubkey::default(),
        }
    }

    fn build(&self, config: Config) -> EscrowAgreement {
        EscrowAgreement {
            schema_version: AGREEMENT_SCHEMA_VERSION,
            bump: 254,
            vault_authority_bump: 253,
            vault_bump: 252,
            creator: self.creator,
            counterparty: if config.payee_assigned {
                self.payee
            } else {
                Pubkey::default()
            },
            agreement_id: 7,
            agreement_type: config.agreement_type,
            mint: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
            amount: 1_000,
            terms_hash: [3; 32],
            state: config.state,
            created_at: 1,
            funded_at: 0,
            completed_at: 0,
            settled_at: 0,
            proof_count: 0,
            settlement_proof: Pubkey::default(),
            dispute_opened_by: Pubkey::default(),
            state_changed_at: 0,
            milestone_count: 0,
            milestones_settled: 0,
            milestone_total: 0,
            settled_total: 0,
            reserved: [0; 40],
        }
    }
}

/// The rules, stated once.
///
/// Each entry is a guard, the roles the protocol intends to allow, the states
/// it is legal in, whether it needs a payee to exist, and which agreement
/// types it applies to. Written from intent: if the implementation disagrees,
/// one of the two is wrong and the test says which line to read.
struct Rule {
    guard: &'static str,
    /// Roles permitted to perform it. A role not listed must be refused.
    allowed_roles: &'static [Role],
    allowed_states: &'static [AgreementState],
    /// Whether the payee must already be known.
    requires_payee: bool,
    /// `None` means every type.
    only_types: Option<&'static [AgreementType]>,
    /// Applies the guard and reports whether the code allowed it.
    apply: fn(&EscrowAgreement, &Pubkey) -> bool,
}

const RULES: &[Rule] = &[
    Rule {
        guard: "require_fundable",
        // The buyer's own money, and only before anything is escrowed.
        allowed_roles: &[Role::Creator],
        allowed_states: &[AgreementState::Open],
        requires_payee: false,
        only_types: None,
        apply: |a, s| a.require_fundable(s).is_ok(),
    },
    Rule {
        guard: "require_completable",
        // The seller says the work is done. A milestone contract has no single
        // moment of completion, so it is excluded by type.
        allowed_roles: &[Role::Payee],
        allowed_states: &[AgreementState::Funded],
        requires_payee: true,
        only_types: Some(&[AgreementType::Escrow, AgreementType::Bounty]),
        apply: |a, s| a.require_completable(s).is_ok(),
    },
    Rule {
        guard: "require_settleable",
        // Either party, because the destination is the seller's regardless.
        allowed_roles: &[Role::Creator, Role::Payee],
        allowed_states: &[AgreementState::Completed],
        requires_payee: true,
        only_types: None,
        apply: |a, s| a.require_settleable(s).is_ok(),
    },
    Rule {
        guard: "require_cancellable",
        // Abandoning an agreement nobody funded: no money exists to move.
        allowed_roles: &[Role::Creator],
        allowed_states: &[AgreementState::Open],
        requires_payee: false,
        only_types: None,
        apply: |a, s| a.require_cancellable(s).is_ok(),
    },
    Rule {
        guard: "require_refundable",
        // The seller surrendering its own claim.
        allowed_roles: &[Role::Payee],
        allowed_states: &[AgreementState::Funded, AgreementState::Completed],
        requires_payee: true,
        only_types: None,
        apply: |a, s| a.require_refundable(s).is_ok(),
    },
    Rule {
        guard: "require_disputable",
        // Either party, over money already escrowed. A dispute is between two
        // parties, so it needs both to exist.
        allowed_roles: &[Role::Creator, Role::Payee],
        allowed_states: &[AgreementState::Funded, AgreementState::Completed],
        requires_payee: true,
        only_types: None,
        apply: |a, s| a.require_disputable(s).is_ok(),
    },
    Rule {
        guard: "require_milestone_creatable",
        // The schedule is fixed before the money arrives.
        allowed_roles: &[Role::Creator],
        allowed_states: &[AgreementState::Open],
        requires_payee: true,
        only_types: Some(&[AgreementType::MilestoneContract]),
        apply: |a, s| a.require_milestone_creatable(s).is_ok(),
    },
    Rule {
        guard: "require_proof_submittable",
        // Evidence may be anchored while the agreement is live.
        allowed_roles: &[Role::Creator, Role::Payee],
        allowed_states: &[
            AgreementState::Funded,
            AgreementState::Completed,
            AgreementState::Disputed,
        ],
        requires_payee: false,
        only_types: None,
        apply: |a, s| a.require_proof_submittable(s).is_ok(),
    },
    Rule {
        guard: "require_counterparty_assignable",
        // The one assignable field, for the one type that needs it, once.
        allowed_roles: &[Role::Creator],
        allowed_states: &[AgreementState::Open, AgreementState::Funded],
        requires_payee: false,
        only_types: Some(&[AgreementType::Bounty]),
        apply: |a, s| a.require_counterparty_assignable(s).is_ok(),
    },
];

impl Rule {
    /// What the protocol intends for one (configuration, role) pair.
    fn expected(&self, config: Config, role: Role) -> bool {
        // Nothing can sign for the default address, and an outsider is party
        // to nothing. Neither may ever pass a guard.
        if role == Role::Nobody || role == Role::Outsider {
            return false;
        }
        // A role that does not exist cannot act.
        if role == Role::Payee && !config.payee_assigned {
            return false;
        }
        // `require_counterparty_assignable` is the one guard whose whole point
        // is that the payee is still unknown.
        if self.guard == "require_counterparty_assignable" && config.payee_assigned {
            return false;
        }
        if self.requires_payee && !config.payee_assigned {
            return false;
        }
        if let Some(types) = self.only_types {
            if !types.contains(&config.agreement_type) {
                return false;
            }
        }
        if !self.allowed_states.contains(&config.state) {
            return false;
        }
        self.allowed_roles.contains(&role)
    }
}

/// Every guard, in every reachable configuration, for every role.
///
/// This is the test that would have failed on the unclaimed-bounty dead end
/// before it was fixed, and the reason it is exhaustive rather than sampled:
/// the defect lived in exactly one of the 756 cells below.
#[test]
fn every_guard_agrees_with_the_stated_rules() {
    let world = World::new();
    let mut divergences: Vec<String> = Vec::new();
    let mut checked = 0usize;

    for agreement_type in TYPES {
        for state in STATES {
            for payee_assigned in [true, false] {
                let config = Config {
                    agreement_type,
                    state,
                    payee_assigned,
                };
                if !config.is_reachable() {
                    continue;
                }
                let agreement = world.build(config);
                for rule in RULES {
                    for role in ROLES {
                        let signer = world.address(role);
                        let expected = rule.expected(config, role);
                        let actual = (rule.apply)(&agreement, &signer);
                        checked += 1;
                        if expected != actual {
                            divergences.push(format!(
                                "  {} [{}] as {:?}: model says {}, code says {}",
                                rule.guard,
                                config.label(),
                                role,
                                if expected { "allow" } else { "refuse" },
                                if actual { "allow" } else { "refuse" },
                            ));
                        }
                    }
                }
            }
        }
    }

    assert!(
        divergences.is_empty(),
        "the escrow state machine diverges from the stated rules in {} of {} cases:\n{}",
        divergences.len(),
        checked,
        divergences.join("\n"),
    );
    // A model that stopped exploring would pass silently. Pin the size.
    assert_eq!(checked, 1_008, "the configuration space changed size");
}

/// A terminal state is terminal for *every* guard, not only the ones whose
/// tests happen to mention it.
///
/// Stated separately from the table above because it is the claim that must
/// survive any future rule edit: a guard added later with a terminal state in
/// its `allowed_states` fails here even if its own row is self-consistent.
#[test]
fn no_guard_admits_a_terminal_state() {
    let world = World::new();
    let terminal = [
        AgreementState::Settled,
        AgreementState::Cancelled,
        AgreementState::Refunded,
    ];

    for state in terminal {
        assert!(state.is_terminal(), "{state:?} must report itself terminal");
        for agreement_type in TYPES {
            for payee_assigned in [true, false] {
                let config = Config {
                    agreement_type,
                    state,
                    payee_assigned,
                };
                if !config.is_reachable() {
                    continue;
                }
                let agreement = world.build(config);
                for rule in RULES {
                    for role in ROLES {
                        let signer = world.address(role);
                        assert!(
                            !(rule.apply)(&agreement, &signer),
                            "{} admitted {:?} in terminal state {:?} ({})",
                            rule.guard,
                            role,
                            state,
                            config.label(),
                        );
                    }
                }
            }
        }
    }
}

/// Resolution is a two-party act, and the second party is read from a token
/// account's owner — an address the caller chooses. Every combination of
/// signer and named beneficiary, in every configuration.
#[test]
fn a_dispute_can_only_be_conceded_between_two_real_parties() {
    let world = World::new();

    for agreement_type in TYPES {
        for state in STATES {
            for payee_assigned in [true, false] {
                let config = Config {
                    agreement_type,
                    state,
                    payee_assigned,
                };
                if !config.is_reachable() {
                    continue;
                }
                let agreement = world.build(config);
                for signer_role in ROLES {
                    for beneficiary_role in ROLES {
                        let signer = world.address(signer_role);
                        let beneficiary = world.address(beneficiary_role);
                        // Legal exactly when: the agreement is disputed, both
                        // sides are real and distinct parties, and a payee
                        // exists for there to be a dispute about.
                        let expected = state == AgreementState::Disputed
                            && payee_assigned
                            && matches!(signer_role, Role::Creator | Role::Payee)
                            && matches!(beneficiary_role, Role::Creator | Role::Payee)
                            && signer_role != beneficiary_role;
                        let actual = agreement.require_resolvable(&signer, &beneficiary).is_ok();
                        assert_eq!(
                            expected,
                            actual,
                            "require_resolvable [{}] signer {:?} beneficiary {:?}: \
                             model says {}, code says {}",
                            config.label(),
                            signer_role,
                            beneficiary_role,
                            if expected { "allow" } else { "refuse" },
                            if actual { "allow" } else { "refuse" },
                        );
                    }
                }
            }
        }
    }
}

/// Custody accounting: `record_payout` is the single writer of `settled_total`
/// and the only thing standing between the vault and paying out more than was
/// funded. Walk it to and past the boundary.
#[test]
fn no_sequence_of_payouts_can_exceed_the_funded_amount() {
    let world = World::new();
    let mut agreement = world.build(Config {
        agreement_type: AgreementType::MilestoneContract,
        state: AgreementState::Funded,
        payee_assigned: true,
    });
    agreement.amount = 1_000;

    // Exact consumption, in uneven tranches, is allowed.
    for paid in [400u64, 100, 499] {
        agreement.record_payout(paid).unwrap();
    }
    assert_eq!(agreement.settled_total, 999);
    assert_eq!(agreement.remaining(), 1);

    // One more than remains is refused, and refusal leaves the books alone.
    assert!(agreement.record_payout(2).is_err());
    assert_eq!(agreement.settled_total, 999, "a refused payout still wrote");

    agreement.record_payout(1).unwrap();
    assert_eq!(agreement.remaining(), 0);

    // Nothing further, including zero-value noise that would still count as a
    // settled milestone.
    assert!(agreement.record_payout(1).is_err());

    // And the accumulator itself cannot be walked over the top.
    agreement.settled_total = u64::MAX;
    assert!(
        agreement.record_payout(1).is_err(),
        "payout overflow must fail closed, not wrap",
    );
    assert_eq!(
        agreement.settled_total,
        u64::MAX,
        "an overflowed payout wrote"
    );
}

/// The milestone schedule is the other accumulator, and it is the one a buyer
/// drives directly: `create_milestone` is called once per tranche, and the
/// total may never promise more than the vault will hold.
#[test]
fn a_milestone_schedule_cannot_promise_more_than_the_escrow() {
    let world = World::new();
    let mut agreement = world.build(Config {
        agreement_type: AgreementType::MilestoneContract,
        state: AgreementState::Open,
        payee_assigned: true,
    });
    agreement.amount = 1_000;

    assert_eq!(agreement.record_milestone(600).unwrap(), 0);
    assert_eq!(agreement.record_milestone(300).unwrap(), 1);
    assert_eq!(
        (agreement.milestone_count, agreement.milestone_total),
        (2, 900)
    );

    // One tranche too many, and the books are untouched by the refusal.
    assert!(agreement.record_milestone(101).is_err());
    assert_eq!(
        (agreement.milestone_count, agreement.milestone_total),
        (2, 900),
        "a refused milestone still wrote",
    );

    // The remainder exactly fills the schedule, which is what `fund` requires.
    assert_eq!(agreement.record_milestone(100).unwrap(), 2);
    assert_eq!(agreement.milestone_total, agreement.amount);
    assert!(agreement.record_milestone(1).is_err());
}

/// Settling a milestone advances two counters at once. Neither may move
/// without the other, or the agreement finishes while custody remains — or
/// holds custody it has already paid out.
#[test]
fn a_refused_milestone_settlement_advances_neither_counter() {
    let world = World::new();
    let mut agreement = world.build(Config {
        agreement_type: AgreementType::MilestoneContract,
        state: AgreementState::Funded,
        payee_assigned: true,
    });
    agreement.amount = 1_000;
    agreement.milestone_count = 2;
    agreement.milestone_total = 1_000;

    assert!(!agreement.record_milestone_settled(600, 10).unwrap());
    assert_eq!(
        (agreement.milestones_settled, agreement.settled_total),
        (1, 600)
    );
    assert_eq!(agreement.state, AgreementState::Funded);

    // A tranche larger than what remains is refused whole.
    assert!(agreement.record_milestone_settled(401, 20).is_err());
    assert_eq!(
        (agreement.milestones_settled, agreement.settled_total),
        (1, 600),
        "a refused settlement advanced a counter",
    );
    assert_eq!(agreement.state, AgreementState::Funded);

    // The last tranche finishes the agreement, and the vault owes nothing.
    assert!(agreement.record_milestone_settled(400, 30).unwrap());
    assert_eq!(agreement.state, AgreementState::Settled);
    assert_eq!(agreement.remaining(), 0);
}
