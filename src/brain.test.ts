import { test } from "node:test";
import assert from "node:assert/strict";
import { BAG0, buildLexicon, cashTotal, choosePlay, countsOf, decideBid, score } from "./brain.js";

const lex = buildLexicon(["CAT", "CATS", "STAR", "RATES", "STARE", "TEARS", "RETAINS", "STAINER", "QI", "ZA", "XU"]);

test("score matches the module's length multipliers", () => {
  assert.equal(score("CAT"), 5);
  assert.equal(score("CATS"), 9); // 6 * 3 / 2
  assert.equal(score("RETAINS"), 21); // 7 * 3
});

test("plays a 7-letter word as soon as it can, holds short ones mid-game", () => {
  assert.equal(choosePlay(lex, countsOf("RETAINSX"), 40, 50)?.length, 7);
  assert.equal(choosePlay(lex, countsOf("CATS"), 40, 50), null);
  assert.equal(choosePlay(lex, countsOf("CATS"), 6, 50), "CATS");
});

test("bids: zero when broke or too late, full balance for an endgame gain, never above balance", () => {
  const pool = BAG0.slice();
  assert.equal(decideBid(lex, { letter: "S", rack: countsOf("CAT"), pool, bag: 40, balance: 0 }), 0);
  assert.equal(decideBid(lex, { letter: "S", rack: countsOf("CAT"), pool, bag: 1, balance: 50 }), 0);
  assert.equal(decideBid(lex, { letter: "S", rack: countsOf("CAT"), pool, bag: 5, balance: 37 }), 37);
  const b = decideBid(lex, { letter: "S", rack: countsOf("RETAIN"), pool, bag: 40, balance: 30 });
  assert.ok(b > 0 && b <= 30, `bid ${b}`);
  assert.ok(cashTotal(lex, countsOf("CATSX")) >= 9);
});
