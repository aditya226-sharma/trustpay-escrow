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
//!   * **Advanced escrow mechanics**: expiry with automatic refund so funds are
//!     never stuck, custom (partial) releases, and contractor-anchored delivery
//!     proofs.
//!   * **Production safety**: an admin-controlled pause (circuit breaker) and
//!     strict authorization with revert-on-invalid-state guards.
//!   * Full unit-test coverage in `test.rs`.

#![no_std]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, token, Address, BytesN,
    Env, MuxedAddress,
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
    /// Ledger timestamp after which the escrow can be expired and refunded.
    pub expires_at: u64,
    /// Total value already released to the contractor.
    pub released: i128,
    /// Delivery proof anchored on-chain by the contractor, if any.
    pub proof: Option<BytesN<32>>,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    EscrowCount,
    Escrow(u64),
    Paused,
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
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    /// Create a new escrow. Authorized by the client. Returns the escrow id.
    ///
    /// `expires_at` is a ledger timestamp: after it passes, any caller may
    /// trigger [`Self::claim_expired_refund`] to return the remaining funds to
    /// the client, so funds can never get stuck in an abandoned escrow.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        env: Env,
        client: Address,
        contractor: Address,
        arbitrator: Address,
        token: Address,
        amount: i128,
        milestone_count: u32,
        expires_at: u64,
    ) -> u64 {
        client.require_auth();
        if amount <= 0 {
            panic!("invalid amount");
        }
        if milestone_count == 0 {
            panic!("no milestones");
        }
        if expires_at <= env.ledger().timestamp() {
            panic!("expiry must be in the future");
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
            expires_at,
            released: 0,
            proof: None,
        };
        env.storage()
            .instance()
            .set(&DataKey::Escrow(count), &escrow);

        env.events().publish(
            (symbol_short!("Created"), count),
            (
                escrow.contractor.clone(),
                escrow.amount,
                escrow.milestone_count,
                escrow.expires_at,
            ),
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
            MuxedAddress::from(env.current_contract_address()),
            &escrow.amount,
        );

        escrow.funded = true;
        env.storage()
            .instance()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events()
            .publish((symbol_short!("Funded"), escrow_id), (escrow.amount,));
    }

    /// Release the next milestone payment to the contractor. Authorized by the
    /// client (the payer), who approves each delivered milestone. The final
    /// milestone releases the exact remaining balance so no dust is stuck.
    /// Transitions the escrow to `Completed` after the final milestone.
    pub fn approve_milestone(env: Env, escrow_id: u64) {
        let mut escrow: Escrow = env
            .storage()
            .instance()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");
        escrow.client.require_auth();
        Self::require_can_release(&env, &escrow);
        if escrow.current_milestone >= escrow.milestone_count {
            panic!("already completed");
        }

        let per_milestone = escrow.amount / (escrow.milestone_count as i128);
        let remaining = escrow.amount - escrow.released;
        let last = escrow.current_milestone + 1 == escrow.milestone_count;
        let amount = if last { remaining } else { per_milestone };
        Self::release(&env, &mut escrow, amount);

        escrow.current_milestone += 1;
        env.storage()
            .instance()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (
                symbol_short!("Released"),
                escrow_id,
                escrow.current_milestone,
            ),
            (amount, escrow.status),
        );
    }

    /// Release an arbitrary `amount` to the contractor. Authorized by the
    /// client. Useful for partial payments or bonuses outside the milestone
    /// schedule. Marks the escrow `Completed` when everything is released.
    pub fn release_amount(env: Env, escrow_id: u64, amount: i128) {
        let mut escrow: Escrow = env
            .storage()
            .instance()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");
        escrow.client.require_auth();
        Self::require_can_release(&env, &escrow);
        if amount <= 0 {
            panic!("invalid amount");
        }
        if amount > escrow.amount - escrow.released {
            panic!("exceeds remaining");
        }

        Self::release(&env, &mut escrow, amount);
        env.storage()
            .instance()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (symbol_short!("Released"), escrow_id),
            (amount, escrow.status),
        );
    }

    /// Anchor a delivery proof on-chain. Authorized by the contractor. The
    /// `proof` is expected to be a SHA-256 digest of the delivery artefact,
    /// produced off-chain and committed here before the client approves.
    pub fn submit_delivery_proof(env: Env, escrow_id: u64, proof: BytesN<32>) {
        let mut escrow: Escrow = env
            .storage()
            .instance()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");
        escrow.contractor.require_auth();
        if escrow.status != Status::Active {
            panic!("not active");
        }

        escrow.proof = Some(proof.clone());
        env.storage()
            .instance()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events()
            .publish((symbol_short!("Proof"), escrow_id), (proof,));
    }

    /// Refund the remaining balance to the client once the escrow has expired.
    /// Callable by **anyone** after `expires_at`, so an abandoned escrow can
    /// always be closed. Idempotent: only works while `Active` and `funded`.
    pub fn claim_expired_refund(env: Env, escrow_id: u64) {
        let mut escrow: Escrow = env
            .storage()
            .instance()
            .get(&DataKey::Escrow(escrow_id))
            .expect("escrow not found");
        if escrow.status != Status::Active {
            panic!("not active");
        }
        if !escrow.funded {
            panic!("not funded");
        }
        if env.ledger().timestamp() < escrow.expires_at {
            panic!("not expired");
        }
        Self::require_not_paused(&env);

        let remaining = escrow.amount - escrow.released;
        let token_client = token::Client::new(&env, &escrow.token);
        token_client.transfer(
            &env.current_contract_address(),
            MuxedAddress::from(escrow.client.clone()),
            &remaining,
        );

        escrow.status = Status::Refunded;
        escrow.funded = false;
        env.storage()
            .instance()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events().publish(
            (symbol_short!("Expired"), escrow_id),
            (remaining, env.ledger().timestamp()),
        );
    }

    /// Pause or resume value movement. Authorized by the admin. While paused,
    /// no funds can leave the contract (release / refund paths all revert).
    pub fn set_paused(env: Env, paused: bool) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &paused);
        env.events().publish((symbol_short!("Paused"),), (paused,));
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
        env.storage()
            .instance()
            .set(&DataKey::Escrow(escrow_id), &escrow);

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
        Self::require_not_paused(&env);
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
                    MuxedAddress::from(escrow.contractor.clone()),
                    &remaining,
                );
                escrow.status = Status::Completed;
            }
            Decision::RefundToClient => {
                let remaining = token_client.balance(&env.current_contract_address());
                token_client.transfer(
                    &env.current_contract_address(),
                    MuxedAddress::from(escrow.client.clone()),
                    &remaining,
                );
                escrow.status = Status::Refunded;
            }
            Decision::Hold => {}
        }
        env.storage()
            .instance()
            .set(&DataKey::Escrow(escrow_id), &escrow);

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
        Self::require_can_release(&env, &escrow);

        let remaining = escrow.amount - escrow.released;
        let token_client = token::Client::new(&env, &escrow.token);
        token_client.transfer(
            &env.current_contract_address(),
            MuxedAddress::from(escrow.client.clone()),
            &remaining,
        );

        escrow.status = Status::Refunded;
        escrow.funded = false;
        env.storage()
            .instance()
            .set(&DataKey::Escrow(escrow_id), &escrow);

        env.events()
            .publish((symbol_short!("Refunded"), escrow_id), (remaining,));
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

    /// Read the paused (circuit breaker) flag.
    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Read the anchored delivery proof for an escrow, if any.
    pub fn get_proof(env: Env, escrow_id: u64) -> Option<BytesN<32>> {
        env.storage()
            .instance()
            .get::<_, Escrow>(&DataKey::Escrow(escrow_id))
            .and_then(|e| e.proof)
    }

    // --- internal helpers ---------------------------------------------------

    /// Guard: the escrow must be funded, active, and the contract must not be
    /// paused (no value may leave the contract while the circuit breaker is
    /// open).
    fn require_can_release(env: &Env, escrow: &Escrow) {
        Self::require_not_paused(env);
        if !escrow.funded {
            panic!("not funded");
        }
        if escrow.status != Status::Active {
            panic!("not active");
        }
    }

    fn require_not_paused(env: &Env) {
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic!("paused");
        }
    }

    /// Transfer `amount` out of the contract to the contractor and update the
    /// escrow's released-tracking. Marks the escrow `Completed` when the full
    /// amount has been released.
    fn release(env: &Env, escrow: &mut Escrow, amount: i128) {
        let token_client = token::Client::new(env, &escrow.token);
        token_client.transfer(
            &env.current_contract_address(),
            MuxedAddress::from(escrow.contractor.clone()),
            &amount,
        );
        escrow.released += amount;
        if escrow.released == escrow.amount {
            escrow.status = Status::Completed;
        }
    }
}

#[cfg(test)]
mod test;
