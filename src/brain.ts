// Stellar's brain. It hunts 7- and 8-letter words (3x reward), values a letter by how
// many high-scoring long words it brings within reach given what is still in the bag,
// prices bids off the live market, and cashes everything in early enough to beat lag.

// Index 0 = A ... 25 = Z.
export const VALUE = [1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10];
export const BAG0 = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
// Median price paid per letter across 464 live matches on 2026-11-07.
export const MARKET = [11, 17, 18, 14, 11, 20, 13, 21, 10, 31, 24, 11, 17, 11, 10, 17, 26, 11, 12, 10, 11, 18, 19, 33, 22, 39];
// Before the rack has shape: letters that start long words easily are worth more.
const EARLY = [1, 0.7, 0.7, 0.9, 1.1, 0.6, 0.8, 0.6, 1, 0.4, 0.4, 0.9, 0.7, 1, 0.9, 0.7, 0.3, 1, 1.1, 1, 0.7, 0.5, 0.5, 0.5, 0.6, 0.4];

export const CASH_BAG = 8; // bag at or below this: play everything, best first
export const REFILL_BAL = 10; // balance below this: play a 5+ letter word for coins
export const BLOATED = 11; // rack this big without a long word: play a 5+ letter word

export const li = (ch: string) => ch.charCodeAt(0) - 65;

export function score(word: string): number {
  let b = 0;
  for (const c of word) b += VALUE[li(c)]!;
  const n = word.length;
  if (n <= 3) return b;
  if (n === 4) return Math.floor((b * 3) / 2);
  if (n === 5) return b * 2;
  if (n === 6) return Math.floor((b * 5) / 2);
  return b * 3;
}

export interface Word {
  w: string;
  s: number;
  need: Uint8Array; // count of each letter
  letters: number[]; // distinct letters in the word
}

export interface Lexicon {
  all: Word[]; // highest score first
  long: Word[]; // 7 and 8 letters
}

export function buildLexicon(words: string[]): Lexicon {
  const all: Word[] = [];
  for (const raw of words) {
    const w = raw.trim().toUpperCase();
    if (w.length < 2 || w.length > 15 || !/^[A-Z]+$/.test(w)) continue;
    const need = new Uint8Array(26);
    for (const c of w) need[li(c)]!++;
    const letters: number[] = [];
    for (let i = 0; i < 26; i++) if (need[i]) letters.push(i);
    all.push({ w, s: score(w), need, letters });
  }
  all.sort((a, b) => b.s - a.s || b.w.length - a.w.length);
  return { all, long: all.filter((x) => x.w.length === 7 || x.w.length === 8) };
}

const fits = (W: Word, rack: number[]) => W.letters.every((i) => W.need[i]! <= rack[i]!);

// Best-scoring word of at least `minLen` letters the rack can spell.
export function best(lex: Lexicon, rack: number[], minLen = 2): Word | null {
  for (const W of lex.all) if (W.w.length >= minLen && fits(W, rack)) return W;
  return null;
}

// Points from playing the rack out greedily, best word first.
export function cashTotal(lex: Lexicon, rack: number[]): number {
  const r = rack.slice();
  let total = 0;
  for (let W = best(lex, r); W; W = best(lex, r)) {
    total += W.s;
    for (const i of W.letters) r[i]! -= W.need[i]!;
  }
  return total;
}

// Score-weighted count of long words at most `t` letters away that the bag can still supply.
export function reach(lex: Lexicon, rack: number[], pool: number[], t: number): number {
  let n = 0;
  for (const W of lex.long) {
    let miss = 0;
    let ok = true;
    for (const i of W.letters) {
      const d = W.need[i]! - rack[i]!;
      if (d > 0) {
        miss += d;
        if (miss > t || pool[i]! < d) {
          ok = false;
          break;
        }
      }
    }
    if (ok) n += W.s;
  }
  return n;
}

export interface BidCtx {
  letter: string;
  rack: number[]; // 26 counts
  pool: number[]; // letters believed still in the bag, not counting this one
  bag: number; // match_state.bag_total
  balance: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Coins to bid on `letter`. 0 = skip. Never above balance. */
export function decideBid(lex: Lexicon, c: BidCtx): number {
  const bal = Math.floor(c.balance);
  if (bal <= 0 || c.bag < 2) return 0; // too late to play anything won now
  const L = li(c.letter);
  const withL = c.rack.slice();
  withL[L]!++;

  if (c.bag <= CASH_BAG) {
    // Coins are worthless after the match: pay up for anything that adds points now.
    return cashTotal(lex, withL) > cashTotal(lex, c.rack) ? bal : 0;
  }

  const tiles = c.rack.reduce((a, b) => a + b, 0);
  let m: number;
  if (tiles < 3) {
    m = EARLY[L]!;
  } else {
    const t = clamp(7 - tiles, 1, 3);
    const n0 = reach(lex, c.rack, c.pool, t);
    const n1 = reach(lex, withL, c.pool, t);
    m = clamp(0.6 + 0.45 * Math.log2((n1 + 50) / (n0 + 50)), 0.25, 1.9);
  }
  if (tiles >= 10) m *= 0.6;

  // A letter that completes a long word right now is worth that word.
  const now = (best(lex, withL, 7)?.s ?? 0) - (best(lex, c.rack, 7)?.s ?? 0);

  // Spend faster when the balance outruns what the rest of the bag will cost.
  const pace = clamp(bal / Math.max(20, 2.2 * c.bag), 0.8, 2.5);
  const b = Math.max(MARKET[L]! * m * pace, now * 0.8);
  return clamp(Math.round(b), 0, bal);
}

/** Word to play now, or null to keep holding. */
export function choosePlay(lex: Lexicon, rack: number[], bag: number, balance: number): string | null {
  const long = best(lex, rack, 7);
  if (long) return long.w;
  if (bag <= CASH_BAG) return best(lex, rack, 2)?.w ?? null;
  const tiles = rack.reduce((a, b) => a + b, 0);
  if (balance < REFILL_BAL || tiles >= BLOATED) return best(lex, rack, 5)?.w ?? null;
  return null;
}

export function countsOf(word: string): number[] {
  const r = new Array<number>(26).fill(0);
  for (const c of word) r[li(c)]!++;
  return r;
}
