import Link from "next/link";
import { Stats, Tape, Ticket, TokenPanel } from "@/components/Home";

const icons = {
  swap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </svg>
  ),
  perps: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19V5M4 19h16" />
      <path d="M7 15l4-4 3 3 5-6" />
    </svg>
  ),
  call: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </svg>
  ),
  binary: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <path d="M5 8l3-3 3 3" />
      <path d="M13 16l3 3 3-3" />
    </svg>
  ),
  income: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M9.5 10.5c0-1.2 1.1-2 2.5-2s2.5.8 2.5 2-1.1 1.6-2.5 1.6-2.5.6-2.5 1.8 1.1 2 2.5 2 2.5-.8 2.5-2" />
    </svg>
  ),
  pool: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 15c3 0 3-2 6-2s3 2 6 2 3-2 6-2" />
      <path d="M3 19c3 0 3-2 6-2s3 2 6 2 3-2 6-2" />
      <path d="M8 9l4-5 4 5" />
    </svg>
  ),
  credit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M7 15h4" />
    </svg>
  ),
};

const FAQ: [string, string][] = [
  [
    "Why does my trade fill at the next price and not the current one?",
    "Chainlink only reports a new price when the market has moved enough or enough time has passed, so the latest price can lag the real market. If trades filled at it, anyone who knew the market had moved could trade against the Pool at a price already out of date. Filling at the first price reported after your order closes that door for everyone. In market hours a new price usually arrives within minutes; if none comes within the order window, you get everything back.",
  ],
  [
    "Who is on the other side of my perps trade and my swap?",
    "The Pool: one USDG pool that anyone can deposit into. It takes the other side of every Perps position and sells or buys Stock Tokens for Swap. LPs earn the Pool's share of the fees and gain when traders lose; when traders win, the Pool pays them.",
  ],
  [
    "When is a position liquidated?",
    "When its loss, fees included, reaches the liquidation limit shown on the Perps page (80% of margin at launch). Anyone can liquidate at the latest fresh Chainlink price and earns a small part of the margin; you keep whatever margin is left. Moving a Uniswap pool cannot trigger a liquidation, because only Chainlink prices are used.",
  ],
  [
    "What happens on weekends?",
    "Stock prices stop updating when markets close, so new orders, deposits and withdrawals wait for the next update. Open positions stay open; nothing can be liquidated on a stale price.",
  ],
  [
    "How do Earn vaults and the options desk work?",
    "An Earn vault sells options on one stock each week through the options desk: cash-secured puts below the market while it holds USDG, covered calls above it if a put was exercised. Anyone can also write or buy calls and puts on the desk directly. Every option is fully collateralized and settles physically.",
  ],
  [
    "How do predictions settle?",
    "Two traders stake the same amount on opposite sides of a strike. At expiry the bet settles on the Chainlink price that was current then, and the winner takes both stakes less the fee. There is no house.",
  ],
  [
    "Who controls the contracts?",
    "Settings sit behind a 48-hour timelock, so every change is public two days before it takes effect. A guardian can only pause new activity and lower caps; it cannot unpause, raise limits or move funds. Closing positions, withdrawals and vault exits keep working while paused. The keeper is a bot that fills orders and runs vaults inside limits written into the contracts.",
  ],
  [
    "Do I own the stock?",
    "Robinhood Stock Tokens track listed shares, and Swap moves the tokens themselves. Holding a token is not holding the share: no votes, and corporate actions are applied by the token's issuer. Perps positions are synthetic: you hold exposure, not tokens.",
  ],
];

export default function Home() {
  return (
    <>
      <div className="wrap">
        <section className="hero">
          <div>
            <p className="eyebrow">Stock DeFi on Robinhood Chain</p>
            <h1>
              Swap, trade and earn
              <br />
              <span className="grad">on tokenized stocks.</span>
            </h1>
            <p className="lead">
              Swap Robinhood Stock Tokens at the Chainlink price. Go long or short up to 10x. Back the market as an LP, earn option
              premiums in USDG, or predict where a stock finishes.
            </p>
            <div className="row">
              <Link className="btn primary" href="/perps/">
                Trade perps
              </Link>
              <Link className="btn ghost" href="/pool/">
                Provide liquidity
              </Link>
            </div>
          </div>
          <Ticket />
        </section>
      </div>
      <Tape />
      <div className="wrap">
        <Stats />

        <section className="sec">
          <div className="sec-h">
            <p className="eyebrow">Products</p>
            <h2>Everything you can do with a Stock Token.</h2>
            <p>All of it runs from your wallet, priced by Chainlink. Nothing to sign up for.</p>
          </div>
          <div className="prod">
            <Link className="card big" href="/perps/">
              <span className="icon">{icons.perps}</span>
              <h3>Perps</h3>
              <p>Long or short TSLA, NVDA, AAPL and more with USDG margin, up to 10x. The Pool takes the other side of every position.</p>
              <div className="foot">
                <span className="tag">Up to 10x</span>
                <span className="tag">Chainlink prices</span>
              </div>
            </Link>
            <Link className="card big" href="/swap/">
              <span className="icon">{icons.swap}</span>
              <h3>Swap</h3>
              <p>Buy and sell Stock Tokens against the Pool at the Chainlink price, for a flat fee and no other slippage.</p>
              <div className="foot">
                <span className="tag">Flat fee</span>
                <span className="tag">No price impact</span>
              </div>
            </Link>
            <Link className="card" href="/pool/">
              <span className="icon">{icons.pool}</span>
              <h3>Pool</h3>
              <p>Deposit USDG and be the house for Perps and Swap. Earn the Pool&apos;s share of every fee.</p>
              <div className="foot">
                <span className="tag violet">LP in USDG</span>
              </div>
            </Link>
            <Link className="card" href="/vaults/">
              <span className="icon">{icons.income}</span>
              <h3>Earn</h3>
              <p>Income Vaults sell covered calls and cash-secured puts each week; Liquidity Vaults earn one stock&apos;s Uniswap fees.</p>
              <div className="foot">
                <span className="tag violet">Premiums in USDG</span>
              </div>
            </Link>
            <Link className="card" href="/trade/">
              <span className="icon">{icons.call}</span>
              <h3>Options desk</h3>
              <p>Write or buy fully collateralized calls and puts, settled by delivering the tokens.</p>
              <div className="foot">
                <span className="tag violet">Physical settlement</span>
              </div>
            </Link>
            <Link className="card" href="/binaries/">
              <span className="icon">{icons.binary}</span>
              <h3>Predict</h3>
              <p>Pick above or below a strike. Someone takes the other side and the winner takes both stakes at expiry.</p>
              <div className="foot">
                <span className="tag violet">Peer to peer</span>
              </div>
            </Link>
            <Link className="card" href="/borrow/">
              <span className="icon">{icons.credit}</span>
              <h3>Borrow</h3>
              <p>Lend USDG for interest, or borrow USDG against Liquidity Vault shares in an isolated market.</p>
              <div className="foot">
                <span className="tag violet">Isolated risk</span>
              </div>
            </Link>
          </div>
        </section>

        <section className="sec">
          <div className="sec-h">
            <p className="eyebrow">How a trade fills</p>
            <h2>Order, next price, done.</h2>
          </div>
          <div className="steps">
            <div className="card">
              <h3>You place an order</h3>
              <p>Your margin or tokens are held by the contract with a limit price you choose. Nothing has filled yet.</p>
            </div>
            <div className="card">
              <h3>Chainlink reports a new price</h3>
              <p>
                The order fills at the first Chainlink price reported after it went in, a price nobody could know when you placed it.
                The keeper fills it, or you can tap Fill now.
              </p>
            </div>
            <div className="card">
              <h3>Filled, or fully refunded</h3>
              <p>If that price is past your limit, or no price arrives within the order window, everything comes back to you.</p>
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="sec-h">
            <p className="eyebrow">Safety</p>
            <h2>What the code guarantees.</h2>
            <p>Read it yourself: every contract is published and verified.</p>
          </div>
          <ul className="checks">
            <li>
              <span>
                <b>No stale-price trading.</b> Perps and Swap fill at the next Chainlink price, never one already known.
              </span>
            </li>
            <li>
              <span>
                <b>Capped risk for LPs.</b> Open interest is capped per market and against the Pool&apos;s value, and profit per position is capped.
              </span>
            </li>
            <li>
              <span>
                <b>Exits never pause.</b> Closing positions, withdrawals and vault exits keep working while new activity is paused.
              </span>
            </li>
            <li>
              <span>
                <b>Full collateral.</b> No option can be sold before the writer has locked everything it could ever pay out.
              </span>
            </li>
            <li>
              <span>
                <b>48-hour timelock.</b> Every settings change is public two days before it runs. The guardian can only pause and tighten.
              </span>
            </li>
            <li>
              <span>
                <b>Chainlink, checked.</b> Stale feeds, a USDG depeg and the token issuer&apos;s corporate-action flag stop trading
                instead of being trusted.
              </span>
            </li>
          </ul>
          <TokenPanel />
        </section>

        <section className="sec">
          <div className="sec-h">
            <p className="eyebrow">FAQ</p>
            <h2>Questions, answered.</h2>
          </div>
          <div className="faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="cta">
          <h2>Trade tokenized stocks from your wallet.</h2>
          <div className="row">
            <Link className="btn primary" href="/perps/">
              Trade perps
            </Link>
            <Link className="btn ghost" href="/docs/">
              Read the docs
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
