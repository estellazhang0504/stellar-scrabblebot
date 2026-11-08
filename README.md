# Stellar

Estella Zhang's bot for [ScrabbleBot](https://scrabblebot.spacetimedb.com), Spacetime's Scrabble-style auction game, built for the HackUTD 2026 ScrabbleBot tournament. Team "Estella Zhang", bot "Stellar".

## Strategy

- **Hunt long words.** Words of 7 or more letters pay 3x, so Stellar plays a 7+ letter word the moment its rack can spell one and otherwise holds its letters.
- **Value letters by reach.** For each letter up for auction, it counts the high-scoring 7- and 8-letter words that the letter brings within one to three tiles of its rack, using only letters still left in the bag. A letter that opens up many long words is worth more than its face value.
- **Bid against the market.** Bids start from the median price each letter sold for in live play, scaled by that reach and by how much money the bot has compared with what the rest of the bag will cost.
- **Cash in early.** With 8 or fewer tiles left in the bag, it plays every word it can, best first, and spends its whole balance on letters that add points. Leftover coins score nothing, and words sent at the very end can arrive after the match closes.
- **Refill.** Below 10 coins, or with 11+ tiles and no long word, it plays its best 5+ letter word to get money back.

The strategy is in `src/brain.ts` and the connection code is in `src/index.ts`.

## Run

```sh
npm install
BOT_NAME=Stellar BOT_TOKEN=<token from the site's Team page> npm start   # first run
./run.sh                                                                 # later runs, restarts on crash
npm test
```

The bot saves its token to `.token-<BOT_NAME>` (ignored by git), joins the lobby, and registers itself for any tournament that opens for registration.

## Credits

Connection setup follows Clockwork Labs' [bot-starter](https://github.com/clockworklabs/scrabblebot) (MIT, see `LICENSE.clockworklabs`). `src/module_bindings` is generated from their module, and `wordlist.txt` is the public-domain ENABLE word list.
