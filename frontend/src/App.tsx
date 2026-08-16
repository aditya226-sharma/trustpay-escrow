import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveMilestone,
  claimExpiredRefund,
  createEscrow,
  fundEscrow,
  getEscrow,
  getEscrowCount,
  mutualRefund,
  raiseDispute,
  releaseAmount,
  resolveDispute,
  submitDeliveryProof,
  type EscrowData,
} from "./lib/contracts";
import { fetchEscrowEvents, type LiveEvent } from "./lib/events";
import { connectWallet, detectWallet, type WalletState } from "./lib/wallet";
import { ARBITRATOR_CONTRACT, ESCROW_CONTRACT, TOKEN_CONTRACT, TOKEN_SYMBOL } from "./config";
import { escrowProgress, fmtAmount, formatAddress } from "./lib/format";

type Tx = {
  pending: boolean;
  hash: string | null;
  error: string | null;
  success: string | null;
};

function emptyTx(): Tx {
  return { pending: false, hash: null, error: null, success: null };
}

export default function App() {
  const [wallet, setWallet] = useState<WalletState>({ status: "loading" });
  const [escrows, setEscrows] = useState<Array<{ id: number; data: EscrowData }>>([]);
  const [count, setCount] = useState(0);
  const [loadingEscrows, setLoadingEscrows] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [eventsCursor, setEventsCursor] = useState(0);
  const [tx, setTx] = useState<Tx>(emptyTx());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const publicKey = wallet.status === "connected" ? wallet.publicKey : null;

  useEffect(() => {
    detectWallet().then(setWallet);
  }, []);

  const loadEscrows = useCallback(
    async (pk: string) => {
      setLoadingEscrows(true);
      setTx((t) => ({ ...t, error: null }));
      try {
        const c = await getEscrowCount(pk);
        setCount(c);
        const rows: Array<{ id: number; data: EscrowData }> = [];
        // Escrow ids are 1-based (the first escrow created has id 1).
        for (let id = 1; id <= c; id++) {
          const data = await getEscrow(pk, id);
          rows.push({ id, data });
        }
        setEscrows(rows);
      } catch (err) {
        setTx((t) => ({
          ...t,
          error: err instanceof Error ? err.message : "Could not load escrows",
        }));
      } finally {
        setLoadingEscrows(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!publicKey) return;
    loadEscrows(publicKey);
  }, [publicKey, loadEscrows]);

  // Live event streaming: poll the RPC server for new contract events.
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const { events: newEvents, cursor } = await fetchEscrowEvents(eventsCursor);
        if (active && newEvents.length > 0) {
          setEvents((prev) => {
            const seen = new Set(prev.map((e) => e.id));
            const merged = [...newEvents.filter((e) => !seen.has(e.id)), ...prev];
            return merged.slice(0, 40);
          });
          setEventsCursor((prev) => Math.max(prev, cursor));
        }
      } catch {
        // Ignore transient polling errors; the next tick will retry.
      }
    };
    tick();
    intervalRef.current = window.setInterval(tick, 6000);
    return () => {
      active = false;
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    };
  }, [eventsCursor]);

  const onConnect = async () => {
    try {
      const pk = await connectWallet();
      setWallet({ status: "connected", publicKey: pk });
    } catch (err) {
      setTx({ ...emptyTx(), error: err instanceof Error ? err.message : "Connection failed" });
    }
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    if (!publicKey) return;
    setTx({ pending: true, hash: null, error: null, success: null });
    try {
      await fn();
      setTx({ pending: false, hash: null, error: null, success: label });
      await loadEscrows(publicKey);
    } catch (err) {
      setTx({
        pending: false,
        hash: null,
        error: err instanceof Error ? err.message : `${label} failed`,
        success: null,
      });
    }
  };

  const onCreate = async (p: {
    contractor: string;
    amount: number;
    milestones: number;
    expiresInDays: number;
  }) => {
    if (!publicKey) return;
    await run("Escrow created", async () => {
      const expiresAt = Math.floor(Date.now() / 1000) + p.expiresInDays * 86400;
      await createEscrow(
        publicKey,
        {
          client: publicKey,
          contractor: p.contractor,
          arbitrator: ARBITRATOR_CONTRACT,
          token: TOKEN_CONTRACT,
          amount: p.amount,
          milestoneCount: p.milestones,
          expiresAt,
        },
        (hash) => setTx((t) => ({ ...t, hash })),
      );
    });
  };

  const escrowActions = (id: number, data: EscrowData) => {
    const actions: Array<{ label: string; fn: () => Promise<void>; disabled: boolean }> = [
      {
        label: "Fund",
        fn: () => run("Escrow funded", () => fundEscrow(publicKey!, id, (h) => setTx((t) => ({ ...t, hash: h })))),
        disabled: data.funded || data.status !== "Active",
      },
      {
        label: "Approve milestone",
        fn: () => run("Milestone approved", () => approveMilestone(publicKey!, id, (h) => setTx((t) => ({ ...t, hash: h })))),
        disabled:
          !data.funded || data.status !== "Active" || data.current_milestone >= data.milestone_count,
      },
      {
        label: "Raise dispute",
        fn: () => run("Dispute raised", () => raiseDispute(publicKey!, id, publicKey!, (h) => setTx((t) => ({ ...t, hash: h })))),
        disabled: data.status !== "Active",
      },
      {
        label: "Resolve dispute (admin)",
        fn: () => run("Dispute resolved", () => resolveDispute(publicKey!, id, (h) => setTx((t) => ({ ...t, hash: h })))),
        disabled: data.status !== "Disputed",
      },
      {
        label: "Mutual refund",
        fn: () => run("Refund executed", () => mutualRefund(publicKey!, id, (h) => setTx((t) => ({ ...t, hash: h })))),
        disabled: data.status !== "Active",
      },
      {
        label: "Claim expired refund",
        fn: () => run("Expired refund claimed", () => claimExpiredRefund(publicKey!, id, (h) => setTx((t) => ({ ...t, hash: h })))),
        disabled:
          data.status !== "Active" ||
          !data.funded ||
          Number(data.expires_at) > Math.floor(Date.now() / 1000),
      },
    ];
    return actions;
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="logo">⧖</span>
          <div>
            <h1>TrustPay</h1>
            <p className="tagline">Milestone escrow payments on Stellar</p>
          </div>
        </div>
        {wallet.status === "loading" ? (
          <button className="btn btn-outline" disabled>
            Checking wallet…
          </button>
        ) : wallet.status === "connected" ? (
          <div className="wallet">
            <span className="dot" />
            <span className="addr" title={wallet.publicKey}>
              {formatAddress(wallet.publicKey)}
            </span>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={onConnect}>
            Connect Freighter
          </button>
        )}
      </header>

      <main className="main">
        {wallet.status === "connected" && publicKey ? (
          <>
            <section className="hero">
              <h2>Pay for work in milestones, dispute-free.</h2>
              <p>
                Funds are locked on-chain and only released when you approve each
                milestone. Disputes go to a neutral on-chain arbitrator.
              </p>
            </section>

            {(tx.error || tx.success) && (
              <div className={`banner ${tx.error ? "banner-error" : "banner-success"}`} role="status">
                <span>
                  {tx.error ?? tx.success}
                  {tx.hash && (
                    <a
                      className="hash-link"
                      href={`https://stellar.expert/explorer/testnet/tx/${tx.hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      view tx
                    </a>
                  )}
                </span>
                <button className="banner-close" onClick={() => setTx(emptyTx())}>
                  ✕
                </button>
              </div>
            )}

            <CreateEscrowForm
              disabled={tx.pending}
              onSubmit={onCreate}
              clientAddress={publicKey}
            />

            <section className="panel">
              <div className="panel-head">
                <h3>Escrows</h3>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => loadEscrows(publicKey)}
                  disabled={loadingEscrows || tx.pending}
                >
                  {loadingEscrows ? "Loading…" : "Refresh"}
                </button>
              </div>
              {loadingEscrows ? (
                <p className="muted">Loading escrows…</p>
              ) : escrows.length === 0 ? (
                <p className="muted">
                  No escrows yet. Create one above — funds stay locked on-chain.
                </p>
              ) : (
                <div className="escrow-grid">
                  {escrows.map(({ id, data }) => (
                    <EscrowCard
                      key={id}
                      id={id}
                      data={data}
                      publicKey={publicKey}
                      disabled={tx.pending}
                      actions={escrowActions(id, data)}
                      onRelease={(amount) =>
                        run("Custom release executed", () =>
                          releaseAmount(publicKey, id, amount, (h) => setTx((t) => ({ ...t, hash: h }))),
                        )
                      }
                      onProof={(hex) =>
                        run("Delivery proof anchored", () =>
                          submitDeliveryProof(publicKey, id, hex, (h) => setTx((t) => ({ ...t, hash: h }))),
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <h3>Live events</h3>
                <span className="live-badge">● streaming</span>
              </div>
              <EventFeed events={events} />
            </section>

            <section className="panel details">
              <button className="linklike" onClick={() => setShowAdvanced((s) => !s)}>
                {showAdvanced ? "Hide" : "Show"} deployed contract details
              </button>
              {showAdvanced && (
                <dl>
                  <dt>Escrow contract</dt>
                  <dd>
                    <a
                      href={`https://stellar.expert/explorer/testnet/contract/${ESCROW_CONTRACT}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {ESCROW_CONTRACT}
                    </a>
                  </dd>
                  <dt>Arbitrator contract</dt>
                  <dd>{ARBITRATOR_CONTRACT}</dd>
                  <dt>Token</dt>
                  <dd>{TOKEN_CONTRACT} (testnet asset)</dd>
                  <dt>Total escrows on-chain</dt>
                  <dd>{count}</dd>
                </dl>
              )}
            </section>
          </>
        ) : (
          <section className="connect-prompt">
            <div className="connect-card">
              <span className="logo logo-lg">⧖</span>
              <h2>Connect your Freighter wallet</h2>
              <p>
                TrustPay is a demo escrow dApp on the Stellar testnet. Connect
                Freighter to create escrows, fund them, approve milestones and
                stream live on-chain events.
              </p>
              <button className="btn btn-primary btn-lg" onClick={onConnect} disabled={wallet.status === "loading"}>
                {wallet.status === "loading" ? "Checking wallet…" : "Connect Freighter"}
              </button>
              <p className="muted small">
                Don't have Freighter? Install the{" "}
                <a href="https://www.freighter.app/" target="_blank" rel="noreferrer">
                  Freighter
                </a>{" "}
                browser extension, then fund your account with the testnet
                friendbot.
              </p>
            </div>
          </section>
        )}
      </main>

      <footer className="footer">
        <p>
          TrustPay · Stellar Soroban testnet ·{" "}
          <a href="https://github.com/aditya226-sharma/trustpay-escrow" target="_blank" rel="noreferrer">
            source on GitHub
          </a>
        </p>
      </footer>
    </div>
  );
}

function CreateEscrowForm({
  disabled,
  onSubmit,
  clientAddress,
}: {
  disabled: boolean;
  onSubmit: (p: { contractor: string; amount: number; milestones: number; expiresInDays: number }) => Promise<void>;
  clientAddress: string;
}) {
  const [contractor, setContractor] = useState("");
  const [amount, setAmount] = useState("500");
  const [milestones, setMilestones] = useState("3");
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setError(`Amount must be a positive number of ${TOKEN_SYMBOL}.`);
      return;
    }
    const ms = Math.round(Number(milestones));
    if (!Number.isFinite(ms) || ms < 1 || ms > 12) {
      setError("Milestones must be between 1 and 12.");
      return;
    }
    const days = Math.round(Number(expiresInDays));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      setError("Expiry must be between 1 and 365 days.");
      return;
    }
    if (!/^G[A-Z0-9]{55}$/.test(contractor.trim())) {
      setError("Contractor address must be a valid Stellar G… address.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ contractor: contractor.trim(), amount: amountNum, milestones: ms, expiresInDays: days });
      setContractor("");
    } catch {
      // Error banner is rendered by the parent.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel create-form">
      <h3>Create an escrow</h3>
      <form onSubmit={submit}>
        <div className="form-row">
          <label>
            Contractor (G…)
            <input
              type="text"
              value={contractor}
              onChange={(e) => setContractor(e.target.value)}
              placeholder="GDD…"
              required
              disabled={disabled || submitting}
            />
          </label>
        </div>
        <div className="form-row two">
          <label>
            Amount
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              min={0}
              step="0.1"
              required
              disabled={disabled || submitting}
            />
          </label>
          <label>
            Milestones
            <input
              type="number"
              value={milestones}
              onChange={(e) => setMilestones(e.target.value)}
              min={1}
              max={12}
              step={1}
              required
              disabled={disabled || submitting}
            />
          </label>
          <label>
            Expires in (days)
            <input
              type="number"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              min={1}
              max={365}
              step={1}
              required
              disabled={disabled || submitting}
            />
          </label>
        </div>
        <p className="muted small">
          After the expiry date passes, anyone can claim a refund of the remaining
          balance — funds never get stuck.
        </p>
        {error && <p className="form-error">{error}</p>}
        <div className="form-foot">
          <p className="muted small">
            You (the client) fund this escrow: <code>{formatAddress(clientAddress)}</code>
          </p>
          <button type="submit" className="btn btn-primary" disabled={disabled || submitting}>
            {submitting ? "Submitting…" : "Create escrow"}
          </button>
        </div>
      </form>
    </section>
  );
}

function EscrowCard({
  id,
  data,
  publicKey,
  disabled,
  actions,
  onRelease,
  onProof,
}: {
  id: number;
  data: EscrowData;
  publicKey: string;
  disabled: boolean;
  actions: Array<{ label: string; fn: () => Promise<void>; disabled: boolean }>;
  onRelease: (amount: number) => Promise<void>;
  onProof: (hex: string) => Promise<void>;
}) {
  const progress = escrowProgress(data.current_milestone, data.milestone_count);
  const isClient = data.client === publicKey;
  const isContractor = data.contractor === publicKey;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [releaseValue, setReleaseValue] = useState("");
  const [proofValue, setProofValue] = useState("");
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = data.status === "Active" && Number(data.expires_at) <= nowSec;
  const remaining = data.amount - data.released;

  return (
    <div className={`escrow-card status-${data.status.toLowerCase()}`}>
      <div className="escrow-head">
        <span className="escrow-id">#{id}</span>
        <span className={`badge badge-${data.status.toLowerCase()}`}>{data.status}</span>
      </div>
      <div className="escrow-amount">{fmtAmount(data.amount)} <span className="unit">{TOKEN_SYMBOL}</span></div>
      <div className="escrow-roles">
        <div>
          <span className="muted small">Client</span>
          <span className="addr" title={data.client}>
            {isClient ? "you" : formatAddress(data.client)}
          </span>
        </div>
        <div>
          <span className="muted small">Contractor</span>
          <span className="addr" title={data.contractor}>
            {isContractor ? "you" : formatAddress(data.contractor)}
          </span>
        </div>
      </div>
      <div className="progress">
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <span className="muted small">
          Milestone {data.current_milestone} / {data.milestone_count} · released{" "}
          {fmtAmount(data.released)} / {fmtAmount(data.amount)}
        </span>
      </div>
      <div className="escrow-meta">
        <span className={`muted small ${expired ? "expired" : ""}`}>
          {data.status === "Active"
            ? expired
              ? "Expired — refund can be claimed"
              : `Expires ${new Date(Number(data.expires_at) * 1000).toLocaleString()}`
            : "Closed"}
        </span>
        {data.proof && (
          <span className="muted small" title="Delivery proof hash (SHA-256)">
            proof {data.proof.slice(0, 10)}…
          </span>
        )}
      </div>
      <div className="escrow-actions">
        {actions
          .filter((a) => !a.disabled)
          .map((a) => (
            <button key={a.label} className="btn btn-outline btn-sm" disabled={disabled} onClick={a.fn}>
              {a.label}
            </button>
          ))}
        {actions.every((a) => a.disabled) && <span className="muted small">No actions available</span>}
      </div>
      <div className="escrow-advanced">
        <button
          className="linklike small"
          onClick={() => setShowAdvanced((s) => !s)}
          disabled={disabled}
        >
          {showAdvanced ? "Hide" : "Show"} advanced
        </button>
        {showAdvanced && (
          <div className="advanced-row">
            {isClient && data.status === "Active" && data.funded && (
              <div className="inline-form">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder={`Release up to ${fmtAmount(remaining)}`}
                  value={releaseValue}
                  onChange={(e) => setReleaseValue(e.target.value)}
                  disabled={disabled}
                />
                <button
                  className="btn btn-outline btn-sm"
                  disabled={disabled || !releaseValue}
                  onClick={async () => {
                    const v = Number(releaseValue);
                    if (!Number.isFinite(v) || v <= 0) return;
                    await onRelease(v);
                    setReleaseValue("");
                  }}
                >
                  Custom release
                </button>
              </div>
            )}
            {isContractor && data.status === "Active" && (
              <div className="inline-form">
                <input
                  type="text"
                  placeholder="Delivery proof hash (64 hex)"
                  value={proofValue}
                  onChange={(e) => setProofValue(e.target.value)}
                  disabled={disabled}
                />
                <button
                  className="btn btn-outline btn-sm"
                  disabled={disabled || !proofValue.trim()}
                  onClick={async () => {
                    await onProof(proofValue.trim());
                    setProofValue("");
                  }}
                >
                  Anchor proof
                </button>
              </div>
            )}
            {!isClient && !isContractor && <span className="muted small">Actions are reserved for the client and contractor.</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function EventFeed({ events }: { events: LiveEvent[] }) {
  if (events.length === 0) {
    return <p className="muted">No events yet. Create or fund an escrow to see live Soroban events.</p>;
  }
  return (
    <ul className="event-list">
      {events.map((e) => (
        <li key={e.id} className="event-item">
          <span className={`event-kind event-${String(e.topics[0]).toLowerCase()}`}>
            {e.topics[0] ?? "event"}
          </span>
          <span className="event-detail">
            {e.topics.slice(1).map((t, i) => (
              <code key={i} className="topic">
                {String(t).length > 18 ? `${String(t).slice(0, 6)}…${String(t).slice(-6)}` : String(t)}
              </code>
            ))}
          </span>
          <span className="event-meta">
            <a
              href={`https://stellar.expert/explorer/testnet/ledger/${e.ledger}`}
              target="_blank"
              rel="noreferrer"
            >
              ledger {e.ledger}
            </a>
          </span>
        </li>
      ))}
    </ul>
  );
}
