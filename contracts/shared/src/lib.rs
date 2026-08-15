#![no_std]

//! Shared types used by the TrustPay escrow and arbitrator contracts.

use soroban_sdk::{contracttype, Address};

/// The ruling an arbitrator can make on a disputed escrow.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[contracttype]
pub enum Decision {
    ReleaseToContractor,
    RefundToClient,
    Hold,
}

/// A stored ruling for a single escrow id.
#[derive(Clone, Debug)]
#[contracttype]
pub struct DecisionRecord {
    pub decision: Decision,
    pub decided_by: Address,
    pub decided_at: u64,
}
