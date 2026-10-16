import type { CSSProperties, ReactNode } from "react";

// Shared PIKO top bar: brand, app switcher (each app keeps its own accent
// color), and whatever account controls the app passes in as children.
export type PikoAppId = "mine" | "dice" | "blackjack" | "poker" | "pixel";

const PIKO_HOME = "https://www.piko.network/";
const PIKO_APPS: { id: PikoAppId; label: string; url: string; color: string }[] = [
  { id: "mine", label: "Mine", url: "https://5xdl7-taaaa-aaaaj-qseeq-cai.icp.net/", color: "#4fe0a8" },
  { id: "dice", label: "Dice", url: "https://77zu2-baaaa-aaaaj-qseiq-cai.icp.net/", color: "#4aa8ff" },
  { id: "blackjack", label: "Blackjack", url: "https://bcd2h-5iaaa-aaaai-ax4hq-cai.icp.net/", color: "#ff6b5e" },
  { id: "poker", label: "Poker", url: "https://2uuxi-qyaaa-aaaac-qhbyq-cai.icp.net/", color: "#ffc35a" },
  { id: "pixel", label: "Pixel", url: "https://cglm2-byaaa-aaaac-bf4aq-cai.icp.net/", color: "#d07af0" },
];

export function AppNav({ current, children }: { current: PikoAppId; children?: ReactNode }) {
  return (
    <header className="topbar">
      <a className="topbar-brand" href={PIKO_HOME} title="PIKO home">
        <img src="/piko-logo.svg" alt="" />
        <span>PIKO</span>
      </a>
      <nav className="app-nav" aria-label="PIKO apps">
        {PIKO_APPS.map((a) => (
          <a
            key={a.id}
            href={a.url}
            className={a.id === current ? "on" : ""}
            aria-current={a.id === current ? "page" : undefined}
            style={{ "--app": a.color } as CSSProperties}
          >
            {a.label}
          </a>
        ))}
      </nav>
      <div className="wallet-box">{children}</div>
    </header>
  );
}
