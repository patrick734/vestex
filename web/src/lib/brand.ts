import { catalog } from "@/generated/catalog";
import { DEPLOYMENT } from "./deployment";

const token = DEPLOYMENT?.token && /^0x[0-9a-fA-F]{40}$/.test(DEPLOYMENT.token) ? DEPLOYMENT.token : null;

export const BRAND = {
  name: "Vestex",
  domain: "vestex.finance",
  tagline: "Swap, trade and earn on tokenized stocks.",
  /** Shown only when set in Vercel (NEXT_PUBLIC_X_URL, e.g. https://x.com/yourhandle). */
  x: process.env.NEXT_PUBLIC_X_URL || "",
  xHandle: (process.env.NEXT_PUBLIC_X_URL || "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "@").replace(/\/$/, ""),
  /** Shown only when set in Vercel (NEXT_PUBLIC_GITHUB_URL). */
  github: process.env.NEXT_PUBLIC_GITHUB_URL || "",
  /** The Vestex token: present only once it is launched and set on-chain (set-token.sh writes it here). */
  token: token
    ? {
        address: token,
        symbol: DEPLOYMENT?.tokenSymbol || "TOKEN",
        name: DEPLOYMENT?.tokenName || "Vestex",
        ponsUrl: `${catalog.ponsPage}${token}`,
      }
    : null,
};
