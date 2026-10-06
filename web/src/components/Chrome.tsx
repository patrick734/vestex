"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { BRAND } from "@/lib/brand";
import { CHAIN, DEPLOYMENT, addressUrl } from "@/lib/config";
import { short } from "@/lib/format";
import { useOpenWallet } from "./Wallet";

export function Mark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="vx-g" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#2f7bff" />
          <stop offset="1" stopColor="#00c2ff" />
        </linearGradient>
      </defs>
      <path d="M5 9l8.5 15L27 6" fill="none" stroke="url(#vx-g)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="27" cy="6" r="2.4" fill="#00c2ff" />
    </svg>
  );
}

const NAV = [
  ["/swap/", "Swap"],
  ["/perps/", "Perps"],
  ["/pool/", "Pool"],
  ["/vaults/", "Earn"],
  ["/trade/", "Options"],
  ["/binaries/", "Predict"],
  ["/borrow/", "Borrow"],
  ["/docs/", "Docs"],
] as const;

export function Header() {
  const path = usePathname() || "/";
  return (
    <header className="hdr">
      <div className="wrap hdr-in">
        <Link href="/" className="brand" aria-label={`${BRAND.name} home`}>
          <Mark />
          <span>
            Vest<b>ex</b>
          </span>
        </Link>
        <nav className="nav">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className={path.startsWith(href) ? "on" : ""}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="hdr-right">
          <span className="chain">
            <i />
            {CHAIN.name}
          </span>
          <Connect />
        </div>
      </div>
    </header>
  );
}

export function Connect({ wide }: { wide?: boolean }) {
  const open = useOpenWallet();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || !isConnected || !address) {
    return (
      <button className={`btn primary small${wide ? " wide" : ""}`} onClick={open}>
        Connect wallet
      </button>
    );
  }
  return (
    <span className="acct">
      <button className="btn ghost small" title="Disconnect" onClick={() => disconnect()}>
        {short(address)}
      </button>
    </span>
  );
}

export function Footer() {
  const d = DEPLOYMENT;
  return (
    <footer className="ftr">
      <div className="wrap">
        <div className="ftr-in">
          <div>
            <Link href="/" className="brand" style={{ marginBottom: 12 }}>
              <Mark />
              <span>
                Vest<b>ex</b>
              </span>
            </Link>
            <p style={{ margin: 0 }}>{BRAND.tagline}</p>
          </div>
          <div>
            <h4>Protocol</h4>
            <Link href="/swap/">Swap</Link>
            <Link href="/perps/">Perps</Link>
            <Link href="/pool/">Pool</Link>
            <Link href="/vaults/">Earn</Link>
            <Link href="/trade/">Options desk</Link>
            <Link href="/binaries/">Predict</Link>
            <Link href="/borrow/">Borrow</Link>
          </div>
          <div>
            <h4>Contracts</h4>
            {d ? (
              <>
                <a href={addressUrl(d.perps)} target="_blank" rel="noopener">
                  VestexPerps ↗
                </a>
                <a href={addressUrl(d.pool)} target="_blank" rel="noopener">
                  VestexPool ↗
                </a>
                <a href={addressUrl(d.oracle)} target="_blank" rel="noopener">
                  VestexOracle ↗
                </a>
                <Link href="/docs/#contracts">All contracts</Link>
              </>
            ) : (
              <Link href="/docs/#contracts">Contract list</Link>
            )}
          </div>
          <div>
            <h4>More</h4>
            <Link href="/docs/">Docs</Link>
            {BRAND.x && (
              <a href={BRAND.x} target="_blank" rel="noopener">
                X {BRAND.xHandle}
              </a>
            )}
            {BRAND.github && (
              <a href={BRAND.github} target="_blank" rel="noopener">
                Source code
              </a>
            )}
            <Link href="/terms/">Terms</Link>
            <Link href="/privacy/">Privacy</Link>
          </div>
        </div>
        <p className="fine">
          Built on Robinhood Chain. Prices from Chainlink. Vestex is a set of open-source smart contracts and this
          interface to them; nothing here is investment advice. Leveraged positions can be liquidated, options and
          predictions can lose their whole premium or stake, and Stock Tokens are not shares. The contracts have not been independently audited.
        </p>
      </div>
    </footer>
  );
}

export function CopyCA({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="ca">
      <span>{address}</span>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
