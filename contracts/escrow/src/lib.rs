//! TrustPay Escrow
//!
//! Milestone-based escrow payments for remote work on Stellar.
//!
//! The contract demonstrates production-grade smart-contract architecture:
//!   * **Inter-contract communication** with the Stellar Asset Contract (SAC)
//!     token for value transfers and with the `trustpay-arbitrator` contract
//!     for dispute resolution.
//!   * **Event streaming**: every state transition publishes a Soroban event
//!     that off-chain clients can stream in real time.
//!   * Strict authorization, revert-on-invalid-state guards and tests.

#![no_std]

#![allow(deprecated)]

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, Env,
    MuxedAddress,
};
use trustpay_shared::{Decision, DecisionRecord};

/// Interface for the external `trustpay-arbitrator` contract. The escrow
/// contract talks to the arbitrator only through this generated client, which
/// keeps the two contracts fully decoupled at build time.
#[contractclient(name = "ArbitratorClient")]
pub trait ArbitratorInterface {
    fn get_decision(env: Env, escrow_id: u64) -> Option<DecisionRecord>;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[contracttype]
pub enum Status {
    Active,
    Completed,
    Refunded,
    Disputed,
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct Escrow {
    /// The payer (client / buyer) funding the escrow.
    pub client: Address,
    /// The payee (contractor / worker) delivering the milestones.
    pub contractor: Address,
    /// The on-chain arbitrator contract used during disputes.
    pub arbitrator: Address,
    /// The token used for payments (Stellar Asset Contract).
    pub token: Address,
    /// Total amount held in escrow, in the token's base units.
    pub amount: i128,
    /// Total number of milestones the work is split into.
    pub milestone_count: u32,
    /// Index of the next milestone to be released (0-based).
    pub current_milestone: u32,
    /// Whether the client has funded the escrow.
    pub funded: bool,
    /// Current lifecycle status of the escrow.
    pub status: Status,
    /// Ledger timestamp when the escrow was created.
    pub created_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    EscrowCount,
    Escrow(u64),
}

#[contract]
pub struct TrustPayEscrow;

#[contractimpl]
impl TrustPayEscrow {
    /// Initialize the contract. Only callable once, by the admin.
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::EscrowCount, &0u64);
    }

    /// Create a new escrow. Authorized by the client. Returns the escrow id.
    pub fn create(
        env: Env,
        client: Address,
        contractor: Address,
        arbitrator: Address,
        token: Address,
        amount: i128,
        milestone_count: u32,
    ) -> u64 {
        client.require_auth();
        if amount <= 0 {
            panic!("invalid amount");
        }
        if milestone_count == 0 {
            panic!("no milestones");
        }

        let mut count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0);
        count += 1;
        env.storage().instance().set(&DataKey::EscrowCount, &count);

        let escrow = Escrow {
            client,
            contractor,
            arbitrator,
            token,
            amount,
            milestone_count,
            current_milestone: 0,
            funded: false,
            status: Status::Active,
            created_at: env.ledger().timestamp(),
        };
        env.storage().instance().set(&DataKey::Escrow(count), &escrow);

        env.events().publish(
            (symbol_short!("Created"), count),
            (escrow.contractor.clone(), escrow.amount, escrow.milestone_count),
        );
        count
    }

    /// Fund the escrow: moves the full `amount` from the client into the
    /// contract via the SAC token. Authorized by the client.
    pub fn fund(env: Env, escrow_id: u64) {
        let mut escrow: Escrow = env
            .storage()
            .instance()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");
        escrow.client.require_auth();
        if escrow.funded {
            panic!("already funded");
        }
        if escrow.status != Status::Active {
            panic!("not active");
        }

        let token_client = token::Client::new(&env, &escrow.token);
        token_client.transfer(
            &escrow.client,
            &MuxedAddress::from(env.current_contract_address()),
            &escrow.amount,
        );

        escrow.funded = true;
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish((symbol_short!("Funded"), escrow_id), (escrow.amount,));
    }

    /// Release the next milestone payment to the contractor. Authorized by the
    /// contractor. Transitions the escrow to `Completed` after the final one.
    pub fn approve_milestone(env: Env, escrow_id: u64) {
        let mut escrow: Escrow = env
            .storage()
            .instance()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");
        escrow.contractor.require_auth();
        if !escrow.funded {
            panic!("not funded");
        }
        if escrow.status != Status::Active {
            panic!("not active");
        }
        if escrow.current_milestone >= escrow.milestone_count {
            panic!("already completed");
        }

        let per_milestone = escrow.amount / (escrow.milestone_count as i128);
        let token_client = token::Client::new(&env, &escrow.token);
        token_client.transfer(
            &env.current_contract_address(),
            &MuxedAddress::from(escrow.contractor.clone()),
            &per_milestone,
        );

        escrow.current_milestone += 1;
        if escrow.current_milestone == escrow.milestone_count {
            escrow.status = Status::Completed;
        }
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (symbol_short!("Released"), escrow_id, escrow.current_milestone),
            (per_milestone, escrow.status),
        );
    }

    /// Raise a dispute. Authorized by either the client or the contractor.
    pub fn raise_dispute(env: Env, escrow_id: u64, by: Address) {
        let mut escrow: Escrow = env
            .storage()
            .instance()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");
        by.require_auth();
        if by != escrow.client && by != escrow.contractor {
            panic!("unauthorized");
        }
        if escrow.status != Status::Active {
            panic!("not active");
        }

        escrow.status = Status::Disputed;
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (symbol_short!("Disputed"), escrow_id),
            (escrow.contractor.clone(), escrow.client.clone()),
        );
    }

    /// Resolve a dispute by asking the arbitrator contract for its recorded
    /// decision and applying it. Authorized by the contract admin.
    pub fn resolve_dispute(env: Env, escrow_id: u64) {
        let mut escrow: Escrow = env
            .storage()
            .instance()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        if escrow.status != Status::Disputed {
            panic!("not disputed");
        }

        // Inter-contract call: query the arbitrator for its ruling.
        let decision = ArbitratorClient::new(&env, &escrow.arbitrator).get_decision(&escrow_id);
        let record = decision.expect("no decision recorded");

        let token_client = token::Client::new(&env, &escrow.token);
        match record.decision {
            Decision::ReleaseToContractor => {
                let remaining = token_client.balance(&env.current_contract_address());
                token_client.transfer(
                    &env.current_contract_address(),
                    &MuxedAddress::from(escrow.contractor.clone()),
                    &remaining,
                );
                escrow.status = Status::Completed;
            }
            Decision::RefundToClient => {
                let remaining = token_client.balance(&env.current_contract_address());
                token_client.transfer(
                    &env.current_contract_address(),
                    &MuxedAddress::from(escrow.client.clone()),
                    &remaining,
                );
                escrow.status = Status::Refunded;
            }
            Decision::Hold => {}
        }
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (symbol_short!("Resolved"), escrow_id),
            (record.decision, escrow.status),
        );
    }

    /// Mutually cancel the escrow and return the funds to the client.
    /// Authorized by both the client and the contractor.
    pub fn mutual_refund(env: Env, escrow_id: u64) {
        let mut escrow: Escrow = env
            .storage()
            .instance()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");
        escrow.client.require_auth();
        escrow.contractor.require_auth();
        if !escrow.funded {
            panic!("not funded");
        }
        if escrow.status != Status::Active {
            panic!("not active");
        }

        let token_client = token::Client::new(&env, &escrow.token);
        let remaining = token_client.balance(&env.current_contract_address());
        token_client.transfer(
            &env.current_contract_address(),
            &MuxedAddress::from(escrow.client.clone()),
            &remaining,
        );

        escrow.status = Status::Refunded;
        escrow.funded = false;
        env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish((symbol_short!("Refunded"), escrow_id), (remaining,));
    }

    /// Read the full state of an escrow.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Escrow {
        env.storage()
            .instance()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found")
    }

    /// Read the total number of escrows created.
    pub fn get_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::EscrowCount)
            .unwrap_or(0)
    }

    /// Read the admin of the contract.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }
}

#[cfg(test)]
mod test;
