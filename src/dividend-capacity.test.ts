import { describe, expect, it } from "vitest";
import type { Account, Journal } from "./types/api.js";
import { makeAccount, makeJournal, makePosting } from "./__fixtures__/accounting.js";
import { computeDividendCapacity, dividendCit, maxNetDividend, resolveDividendRoles } from "./dividend-capacity.js";

const chart: Account[] = [
  makeAccount(1000, "D", "Varad", "Pangakonto"),
  makeAccount(2110, "C", "Kohustused", "Võlg omanikule"),
  makeAccount(2650, "C", "Kohustused", "Dividendivõlad"),
  makeAccount(2656, "C", "Kohustused", "Dividenditulumaksu võlg"),
  makeAccount(2900, "C", "Omakapital", "Osakapital või aktsiakapital nimiväärtuses"),
  makeAccount(2940, "C", "Omakapital", "Kohustuslik reservkapital"),
  makeAccount(2950, "C", "Omakapital", "Vabatahtlik reservkapital"),
  makeAccount(2960, "C", "Omakapital", "Eelmiste perioodide jaotamata kasum (kahjum)"),
  makeAccount(2970, "C", "Omakapital", "Aruandeaasta kasum (kahjum)"),
  makeAccount(4000, "C", "Tulud", "Müügitulu"),
  makeAccount(5000, "D", "Kulud", "Kulud"),
  makeAccount(8900, "D", "Kulud", "Tulumaks"),
  makeAccount(9000, "D", "Tulud", "Arvestuslik koondtulemus"),
];
const books: Journal[] = [
  makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)], { id: 1 }),
  makeJournal("2024-01-01", [makePosting(1000, "D", 5000), makePosting(2960, "C", 5000)], { id: 2 }),
  makeJournal("2025-06-01", [makePosting(1000, "D", 20000), makePosting(4000, "C", 20000)], { id: 3 }),
];
const roles = resolveDividendRoles(chart);
const capacity = (journals: Journal[]) => computeDividendCapacity({
  accounts: chart,
  journals,
  effectiveDate: "2026-06-01",
  approved: { reportYear: 2025, retainedEarnings: 5000, profitForYear: 20000 },
  roles,
  shareCapitalAccount: 2900,
  restrictedReserveAccounts: [2940],
});

function prng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** A random balanced journal after the report date, registered or draft. */
function randomJournal(rand: () => number, id: number): Journal {
  const ids = chart.map(a => a.id);
  const legs = 2 + Math.floor(rand() * 3);
  const postings = [];
  let balance = 0;
  for (let k = 0; k < legs - 1; k++) {
    const amount = Math.round(rand() * 1_000_000) / 100;
    const side = rand() < 0.5 ? "D" : "C";
    balance += side === "D" ? amount : -amount;
    postings.push(makePosting(ids[Math.floor(rand() * ids.length)]!, side, amount));
  }
  const last = Math.round(balance * 100) / 100;
  postings.push(makePosting(ids[Math.floor(rand() * ids.length)]!, last >= 0 ? "C" : "D", Math.abs(last)));
  const month = String(1 + Math.floor(rand() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(rand() * 28)).padStart(2, "0");
  return makeJournal(`2026-${month}-${day}`, postings, { id, registered: rand() < 0.5 });
}

describe("dividend capacity properties", () => {
  it("lg 1 never exceeds the approved figure and adding any journal after the report never raises it", () => {
    const rand = prng(20261105);
    const approvedCents = 2_500_000;
    for (let run = 0; run < 200; run++) {
      let journals = [...books];
      let previous = capacity(journals).lg1Cents;
      expect(previous).toBe(approvedCents);
      for (let step = 0; step < 6; step++) {
        journals = [...journals, randomJournal(rand, 1000 + run * 10 + step)];
        const result = capacity(journals);
        expect(result.holds).toEqual([]);
        expect(result.lg1Cents).toBeLessThanOrEqual(approvedCents);
        expect(result.lg1Cents).toBeLessThanOrEqual(previous);
        previous = result.lg1Cents;
      }
    }
  });

  it("the maximum is the largest cent that fits, with the CIT rounded as booked", () => {
    const rate = { num: 22, den: 78 };
    const rand = prng(78);
    for (let run = 0; run < 500; run++) {
      const headroom = Math.floor(rand() * 10_000_000);
      const lg1 = Math.floor(rand() * 10_000_000);
      const { max_net_dividend: max } = maxNetDividend(lg1, headroom, rate);
      const cents = Math.round(max * 100);
      const gross = (n: number) => n + Math.round(dividendCit(n / 100, rate) * 100);
      expect(cents).toBeLessThanOrEqual(lg1);
      expect(gross(cents)).toBeLessThanOrEqual(headroom);
      if (cents < lg1) expect(gross(cents + 1)).toBeGreaterThan(headroom);
    }
    expect(maxNetDividend(-100, 5000, rate).max_net_dividend).toBe(0);
    expect(maxNetDividend(5000, -1, rate).max_net_dividend).toBe(0);
  });
});
