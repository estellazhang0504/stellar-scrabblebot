// Stellar: Estella Zhang's ScrabbleBot. Connection setup follows Clockwork Labs' bot-starter
// (MIT, see LICENSE.clockworklabs); the strategy is in brain.ts.
//
// First run: BOT_NAME=Stellar BOT_TOKEN=<token from /team> npm start
// Later runs read .token-<BOT_NAME>. The bot joins the lobby, and registers itself for any
// tournament that opens for registration.

import { DbConnection, type EventContext } from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { BAG0, buildLexicon, choosePlay, decideBid, li } from "./brain.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB = process.env.STDB_DB ?? "scrabblebot";
const NAME = process.env.BOT_NAME ?? "Stellar";
const TOKEN_PATH = path.join(process.cwd(), `.token-${NAME}`);
const here = path.dirname(new URL(import.meta.url).pathname);

const t0 = Date.now();
const LEX = buildLexicon(fs.readFileSync(path.join(here, "..", "wordlist.txt"), "utf8").split("\n"));
console.log(`[${NAME}] ${LEX.all.length} words, ${LEX.long.length} long, in ${Date.now() - t0} ms`);

let me: Identity | null = null;
let botId: bigint | null = null;
const bidOn = new Set<string>();
const tried = new Set<string>(); // tournaments we asked to join
let playing = false;
let ready = false; // match subscription loaded
let playTimer: ReturnType<typeof setTimeout> | null = null;

// One word search per burst of rack changes, not one per row: the initial load holds
// hundreds of rack rows from past matches.
function schedulePlay(conn: DbConnection) {
  if (!ready || playTimer) return;
  playTimer = setTimeout(() => {
    playTimer = null;
    play(conn);
  }, 25);
}

const fail = (what: string) => (e: unknown) =>
  console.warn(`[${NAME}] ${what} failed: ${e instanceof Error ? e.message : e}`);

function readToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function running(conn: DbConnection): bigint[] {
  const out: bigint[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== botId) continue;
    if (conn.db.matchState.id.find(p.matchId)?.status.tag === "Running") out.push(p.matchId);
  }
  return out;
}

function rackOf(conn: DbConnection, matchId: bigint): number[] {
  const r = new Array<number>(26).fill(0);
  for (const h of conn.db.myRack.iter()) if (h.matchId === matchId) r[li(h.letter)]! += h.count;
  return r;
}

function balanceOf(conn: DbConnection, matchId: bigint): number | null {
  for (const p of conn.db.matchParticipant.iter())
    if (p.matchId === matchId && p.botId === botId) return Number(p.balance);
  return null;
}

// Letters not yet sold to anyone and not in our rack. Opponents' opening racks are unknown.
function poolOf(conn: DbConnection, matchId: bigint, rack: number[], open: string): number[] {
  const pool = BAG0.slice();
  for (const r of conn.db.auctionResult.iter()) {
    if (r.matchId !== matchId || r.winnerBotId === undefined || r.winnerBotId === null) continue;
    if (r.winnerBotId !== botId) pool[li(r.letter)]!--;
  }
  for (let i = 0; i < 26; i++) pool[i] = Math.max(0, pool[i]! - rack[i]!);
  pool[li(open)] = Math.max(0, pool[li(open)]! - 1);
  return pool;
}

function bid(conn: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  const key = String(auctionId);
  if (botId === null || bidOn.has(key)) return;
  const bal = balanceOf(conn, matchId);
  const ms = conn.db.matchState.id.find(matchId);
  if (bal === null || ms?.status.tag !== "Running") return;
  bidOn.add(key);
  const rack = rackOf(conn, matchId);
  const amount = decideBid(LEX, { letter, rack, pool: poolOf(conn, matchId, rack, letter), bag: ms.bagTotal, balance: bal });
  if (amount <= 0) return;
  conn.reducers.submitBid({ auctionId, amount: BigInt(amount) }).catch(fail(`bid on ${letter}`));
  console.log(`[${NAME}] bid ${amount} on '${letter}' (match ${matchId}, bag ${ms.bagTotal}, bal ${bal})`);
}

function play(conn: DbConnection) {
  if (botId === null || playing) return;
  playing = true;
  try {
    for (const matchId of running(conn)) {
      const ms = conn.db.matchState.id.find(matchId)!;
      const word = choosePlay(LEX, rackOf(conn, matchId), ms.bagTotal, balanceOf(conn, matchId) ?? 0);
      if (!word) continue;
      console.log(`[${NAME}] match ${matchId}: playing '${word}' (bag ${ms.bagTotal})`);
      conn.reducers.submitWord({ matchId, word }).catch(fail(`playing '${word}'`));
    }
  } finally {
    playing = false;
  }
}

function joinLobby(conn: DbConnection) {
  if (botId === null || running(conn).length > 0) return;
  const open = Array.from(conn.db.lobby.iter()).find((l) => l.status.tag === "Open");
  if (open && Array.from(conn.db.lobbyMember.iter()).some((m) => m.lobbyId === open.id && m.botId === botId)) return;
  conn.reducers.joinLobby({}).catch(fail("joining the lobby"));
}

function register(conn: DbConnection) {
  if (botId === null) return;
  for (const t of conn.db.tournament.iter()) {
    if (t.status.tag !== "Registration" || tried.has(String(t.id))) continue;
    if (Array.from(conn.db.tournamentEntry.iter()).some((e) => e.tournamentId === t.id && e.botId === botId)) continue;
    tried.add(String(t.id));
    console.log(`[${NAME}] registering for tournament ${t.id}`);
    conn.reducers
      .registerForTournament({ tournamentId: t.id })
      .then(() => console.log(`[${NAME}] registered for tournament ${t.id}`))
      .catch((e) => {
        tried.delete(String(t.id));
        fail(`registering for tournament ${t.id}`)(e);
      });
  }
}

function subscribeMatches(conn: DbConnection) {
  const B = String(botId);
  const mine = (t: string) =>
    `SELECT ${t}.* FROM ${t} JOIN match_participant mp ON ${t}.match_id = mp.match_id WHERE mp.bot_id = ${B}`;
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      ready = true;
      console.log(`[${NAME}] match subscription applied`);
      register(conn);
      joinLobby(conn);
      for (const a of conn.db.auction.iter()) if (a.status.tag === "Open") bid(conn, a.id, a.matchId, a.letter);
      play(conn);
    })
    .onError((ctx) => {
      console.error(`[${NAME}] match subscription failed: ${ctx.event}`);
      process.exit(4);
    })
    .subscribe([
      `SELECT * FROM match_participant WHERE bot_id = ${B}`,
      `SELECT ms.* FROM match_state ms JOIN match_participant mp ON ms.id = mp.match_id WHERE mp.bot_id = ${B}`,
      mine("auction"),
      mine("auction_result"),
      "SELECT * FROM my_rack",
      `SELECT * FROM word_play WHERE bot_id = ${B}`,
      `SELECT * FROM tournament_entry WHERE bot_id = ${B}`,
    ]);
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  me = identity;
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  console.log(`[${NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      const cred = conn.db.botCredential.identity.find(me!);
      if (!cred) {
        console.error(`[${NAME}] no bot credential for this token; set BOT_TOKEN`);
        process.exit(1);
      }
      botId = cred.botId;
      console.log(`[${NAME}] acting as bot id ${botId}`);
      subscribeMatches(conn);
    })
    .onError((ctx) => {
      console.error(`[${NAME}] base subscription failed: ${ctx.event}`);
      process.exit(4);
    })
    // Small tables only: a full subscription pulls millions of past auction rows.
    .subscribe([
      "SELECT * FROM bot_credential",
      "SELECT * FROM tournament",
      "SELECT * FROM lobby",
      "SELECT * FROM lobby_member",
    ]);

  conn.db.auction.onInsert((_c: EventContext, a) => {
    if (ready && a.status.tag === "Open") bid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.myRack.onInsert(() => schedulePlay(conn));
  conn.db.myRack.onUpdate(() => schedulePlay(conn));
  conn.db.matchState.onUpdate((_c, old, neu) => {
    if (neu.bagTotal <= 8 && old.bagTotal !== neu.bagTotal) schedulePlay(conn); // cash-in window
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      console.log(`[${NAME}] match ${neu.id} ended`);
      setTimeout(() => joinLobby(conn), 500);
    }
  });
  conn.db.wordPlay.onInsert((_c, w) => {
    if (w.botId === botId) console.log(`[${NAME}] WORD match ${w.matchId} '${w.word}' +${w.totalReward}`);
  });
  conn.db.tournament.onInsert(() => register(conn));
  conn.db.tournament.onUpdate(() => register(conn));
}

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB)
  .withToken(process.env.BOT_TOKEN ?? readToken())
  .onConnect(onConnect)
  .onConnectError((_c, e) => {
    console.error("connect error:", e.message);
    process.exit(2);
  })
  .onDisconnect(() => {
    console.log(`[${NAME}] disconnected`);
    process.exit(3);
  })
  .build();
