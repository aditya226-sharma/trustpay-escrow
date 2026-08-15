//! Test suite for the TrustPay escrow contract.
//!
//! Run with: `cargo test -p trustpay-escrow`

#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Events, token, Address, Env};
use trustpay_arbitrator::{TrustPayArbitrator, TrustPayArbitratorClient};
use trustpay_shared::Decision;

struct Setup {
    env: Env,
    _admin: Address,
    client: Address,
    contractor: Address,
    arbitrator_addr: Address,
    token_addr: Address,
    escrow: TrustPayEscrowClient<'static>,
    minted: i128,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let client = Address::generate(&env);
    let contractor = Address::generate(&env);

    let arbitrator_addr = env.register_contract(None, TrustPayArbitrator);
    let arbitrator = TrustPayArbitratorClient::new(&env, &arbitrator_addr);
    arbitrator.initialize(&admin);

    let token_addr = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let minted = 100_000i128;
    token::StellarAssetClient::new(&env, &token_addr).mint(&client, &minted);

    let escrow_addr = env.register_contract(None, TrustPayEscrow);
    let escrow = TrustPayEscrowClient::new(&env, &escrow_addr);
    escrow.initialize(&admin);

    Setup {
        env,
        _admin: admin,
        client,
        contractor,
        arbitrator_addr,
        token_addr,
        escrow,
        minted,
    }
}

fn client_balance(s: &Setup) -> i128 {
    token::Client::new(&s.env, &s.token_addr).balance(&s.client)
}

fn contractor_balance(s: &Setup) -> i128 {
    token::Client::new(&s.env, &s.token_addr).balance(&s.contractor)
}

fn escrow_balance(s: &Setup) -> i128 {
    token::Client::new(&s.env, &s.token_addr).balance(&s.escrow.address)
}

fn create_default(s: &Setup) -> u64 {
    s.escrow.create(
        &s.client,
        &s.contractor,
        &s.arbitrator_addr,
        &s.token_addr,
        &10_000i128,
        &3,
    )
}

#[test]
fn create_and_fund_moves_tokens_into_escrow() {
    let s = setup();
    let id = create_default(&s);
    assert_eq!(s.escrow.get_count(), 1);

    s.escrow.fund(&id);

    let escrow = s.escrow.get_escrow(&id);
    assert!(escrow.funded);
    assert_eq!(escrow.status, Status::Active);
    assert_eq!(escrow_balance(&s), 10_000);
    assert_eq!(client_balance(&s), s.minted - 10_000);
}

#[test]
fn milestone_release_pays_contractor_per_milestone() {
    let s = setup();
    let id = create_default(&s);
    s.escrow.fund(&id);

    s.escrow.approve_milestone(&id);

    let escrow = s.escrow.get_escrow(&id);
    assert_eq!(escrow.current_milestone, 1);
    assert_eq!(escrow.status, Status::Active);
    // 10_000 / 3 = 3_333 per milestone (integer division)
    assert_eq!(contractor_balance(&s), 3_333);
    assert_eq!(escrow_balance(&s), 6_667);
}

#[test]
fn completing_all_milestones_marks_escrow_completed() {
    let s = setup();
    let id = create_default(&s);
    s.escrow.fund(&id);

    for _ in 0..3 {
        s.escrow.approve_milestone(&id);
    }

    let escrow = s.escrow.get_escrow(&id);
    assert_eq!(escrow.status, Status::Completed);
    assert_eq!(escrow.current_milestone, 3);
    // 3 * 3333 = 9_999; the remaining 1 stays in escrow (integer math).
    assert_eq!(contractor_balance(&s), 9_999);
}

#[test]
fn dispute_raised_by_client_is_resolved_to_contractor() {
    let s = setup();
    let id = create_default(&s);
    s.escrow.fund(&id);
    s.escrow.approve_milestone(&id);

    // Client disagrees with the work -> raises a dispute.
    s.escrow.raise_dispute(&id, &s.client);
    assert_eq!(s.escrow.get_escrow(&id).status, Status::Disputed);

    // Arbitrator rules in favour of the contractor.
    let arbitrator = TrustPayArbitratorClient::new(&s.env, &s.arbitrator_addr);
    arbitrator.set_decision(&id, &Decision::ReleaseToContractor);

    // Admin applies the ruling: inter-contract call to the arbitrator.
    s.escrow.resolve_dispute(&id);

    let escrow = s.escrow.get_escrow(&id);
    assert_eq!(escrow.status, Status::Completed);
    // Contractor keeps the released milestone + the remaining balance.
    assert_eq!(contractor_balance(&s), 10_000);
}

#[test]
fn dispute_resolved_to_refund_returns_funds_to_client() {
    let s = setup();
    let id = create_default(&s);
    s.escrow.fund(&id);
    s.escrow.raise_dispute(&id, &s.contractor);

    let arbitrator = TrustPayArbitratorClient::new(&s.env, &s.arbitrator_addr);
    arbitrator.set_decision(&id, &Decision::RefundToClient);
    s.escrow.resolve_dispute(&id);

    assert_eq!(s.escrow.get_escrow(&id).status, Status::Refunded);
    assert_eq!(client_balance(&s), s.minted);
    assert_eq!(escrow_balance(&s), 0);
}

#[test]
fn mutual_refund_returns_funds_to_client() {
    let s = setup();
    let id = create_default(&s);
    s.escrow.fund(&id);

    s.escrow.mutual_refund(&id);

    assert_eq!(s.escrow.get_escrow(&id).status, Status::Refunded);
    assert_eq!(client_balance(&s), s.minted);
    assert_eq!(escrow_balance(&s), 0);
}

#[test]
#[should_panic(expected = "unauthorized")]
fn unauthorized_address_cannot_raise_dispute() {
    let s = setup();
    let id = create_default(&s);
    s.escrow.fund(&id);

    let stranger = Address::generate(&s.env);
    s.escrow.raise_dispute(&id, &stranger);
}

#[test]
#[should_panic(expected = "already funded")]
fn cannot_fund_twice() {
    let s = setup();
    let id = create_default(&s);
    s.escrow.fund(&id);
    s.escrow.fund(&id);
}

#[test]
#[should_panic(expected = "not funded")]
fn cannot_release_before_funding() {
    let s = setup();
    let id = create_default(&s);
    s.escrow.approve_milestone(&id);
}

#[test]
#[should_panic(expected = "invalid amount")]
fn create_with_zero_amount_reverts() {
    let s = setup();
    s.escrow.create(
        &s.client,
        &s.contractor,
        &s.arbitrator_addr,
        &s.token_addr,
        &0i128,
        &3,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn fund_with_insufficient_balance_reverts() {
    let s = setup();
    // Client only has 100_000; escrow wants more than that.
    let id = s.escrow.create(
        &s.client,
        &s.contractor,
        &s.arbitrator_addr,
        &s.token_addr,
        &1_000_000i128,
        &1,
    );
    s.escrow.fund(&id);
}

#[test]
fn emits_created_event_for_streaming() {
    let s = setup();
    create_default(&s);

    let events = s.env.events().all();
    let contract_events = events.events();
    assert_eq!(contract_events.len(), 1);
    let event = &contract_events[0];
    // Topics: [symbol "Created", escrow_id].
    match &event.body {
        soroban_sdk::xdr::ContractEventBody::V0(v0) => assert_eq!(v0.topics.len(), 2),
    }
}
