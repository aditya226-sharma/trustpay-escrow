#![no_std]

#![allow(deprecated)]

//! TrustPay Arbitrator
//!
//! A small contract that records neutral third-party rulings for TrustPay
//! escrows. When a payment is disputed, the arbitrator decides whether the
//! balance should be released to the contractor or refunded to the client.

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env};
use trustpay_shared::{Decision, DecisionRecord};

#[derive(Clone, Copy)]
#[contracttype]
pub enum DataKey {
    Admin,
    Decision(u64),
}

#[contract]
pub struct TrustPayArbitrator;

#[contractimpl]
impl TrustPayArbitrator {
    /// Initializes the contract with an admin who is allowed to record
    /// decisions.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Records a decision for a given escrow id. Only the admin (the neutral
    /// arbitration party) can record a decision.
    pub fn set_decision(env: Env, escrow_id: u64, decision: Decision) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        let decided_by = env.current_contract_address();
        let decided_at = env.ledger().timestamp();

        env.storage()
            .instance()
            .set(&DataKey::Decision(escrow_id), &DecisionRecord {
                decision,
                decided_by,
                decided_at,
            });

        env.events().publish(
            (symbol_short!("decision"), escrow_id),
            decision,
        );
    }

    /// Reads the stored decision for an escrow id, if any.
    pub fn get_decision(env: Env, escrow_id: u64) -> Option<DecisionRecord> {
        env.storage().instance().get(&DataKey::Decision(escrow_id))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn create_env() -> (Env, Address, TrustPayArbitratorClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, TrustPayArbitrator);
        let client = TrustPayArbitratorClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, admin, client)
    }

    #[test]
    fn records_and_reads_decision() {
        let (_env, _admin, client) = create_env();
        client.set_decision(&7, &Decision::ReleaseToContractor);

        let record = client.get_decision(&7).expect("decision missing");
        assert_eq!(record.decision, Decision::ReleaseToContractor);
        // decided_by is the contract address, not the admin.
        assert_eq!(record.decided_by, client.address);
    }

    #[test]
    fn missing_decision_returns_none() {
        let (_env, _admin, client) = create_env();
        assert!(client.get_decision(&99).is_none());
    }

    #[test]
    fn multiple_escrows_do_not_clash() {
        let (_env, _admin, client) = create_env();
        client.set_decision(&1, &Decision::RefundToClient);
        client.set_decision(&2, &Decision::ReleaseToContractor);
        assert_eq!(
            client.get_decision(&1).unwrap().decision,
            Decision::RefundToClient
        );
        assert_eq!(
            client.get_decision(&2).unwrap().decision,
            Decision::ReleaseToContractor
        );
    }
}
