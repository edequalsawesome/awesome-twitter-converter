#!/usr/bin/env node
// Pre-import content audit. Flags tweets containing slurs, hateful-language
// patterns, or other potentially cancellable content for human review.
//
// Output: summary counts to stdout, full hits as JSON to <out-file>.
//
// Usage:
//   node scripts/audit.js <archive-path> [<out-file>]

import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseTweetsFile, parseAccountFile } from '../lib/parser.js';

const archivePath = resolve(process.argv[2] || '.archives/2026-04-16');
const outFile = resolve(process.argv[3] || '.archives/audit-report.json');

const CATEGORIES = {
  'racial-slur': [
    /\bn[i1]gg(?:er|a|uh)s?\b/i,
    /\bch[i1]nks?\b/i,
    /\bsp[i1]cs?\b/i,
    /\bwetbacks?\b/i,
    /\bg[o0]oks?\b/i,
    /\bjaps?\b/i,
    /\bkikes?\b/i,
    /\btowelheads?\b/i,
    /\bsandn[i1]gg\w*/i,
    /\braghe(?:a)?ds?\b/i,
    /\bcrackers?\b/i,
    /\bcoons?\b/i,
  ],
  'homophobic-slur': [
    /\bfa(?:g|gg?s|gg?ots?|gg?ot)\b/i,
    /\bdykes?\b/i,
    /\bqueers?\b/i,
    /\bhomos?\b/i,
    /\btrann(?:y|ies)\b/i,
    /\bshemales?\b/i,
  ],
  'ableist-slur': [
    /\bret(?:ard|arded|ards)\b/i,
    /\bretarde?\b/i,
    /\bsp(?:az|azz|astic)\b/i,
    /\bmidgets?\b/i,
    /\bcripples?\b/i,
    /\bmongoloids?\b/i,
  ],
  'misogynistic-insult': [
    // "cunt"/"bitch" flagged in attack contexts (crude heuristic — we flag all,
    // user decides)
    /\bcunts?\b/i,
    /\bwhores?\b/i,
    /\bsluts?\b/i,
  ],
  'antisemitic': [
    /\bjews? control\b/i,
    /\bjewish (?:question|problem|conspiracy)\b/i,
    /\b(?:goys?|goyim)\b/i,
    /\bzionist pigs?\b/i,
  ],
  'hate-pattern': [
    // Blunt "i hate <group>" expressions — often heat-of-the-moment venting
    // we'd want to review
    /\bi\s+(?:fucking\s+)?hate\s+(?:women|men|gays?|blacks?|whites?|asians?|muslims?|christians?|jews?|mexicans?|indians?|trans|faggot|retard|arabs?|americans?|republicans?|democrats?|liberals?|conservatives?)\b/i,
    /\bkill\s+(?:all\s+)?(?:women|men|gays?|blacks?|whites?|asians?|muslims?|christians?|jews?|mexicans?|trans|republicans?|democrats?)\b/i,
  ],
  'body-shaming': [
    /\bfat\s+(?:bitch|fuck|slob|pig|bastard|ass|whore)\b/i,
    /\bugly\s+(?:bitch|fuck|slob|pig|bastard|cunt|whore)\b/i,
  ],
  'rape-suicide-joke': [
    // Jokes about these subjects have aged poorly. Flag for review.
    /\brap(?:e|ed|ing)\s+(?:a|that|the|me|you|her|him|them)\b/i,
    /\bsuicide\s+(?:is|was)\s+(?:funny|hilarious|the answer|tempting)\b/i,
    /\bkys\b/i,
    /\bkill\s+your?self\b/i,
  ],
};

function redact(term) {
  // For logging: show first 2 chars + stars so we're not echoing slurs to
  // console in plain form. Hit files contain the real term since they're
  // intended for the owner's review.
  if (term.length <= 2) return '*'.repeat(term.length);
  return term.slice(0, 2) + '*'.repeat(term.length - 2);
}

function extractHitTerm(text, regex) {
  const m = text.match(regex);
  return m ? m[0] : null;
}

const account = parseAccountFile(archivePath);
const tweets = parseTweetsFile(archivePath);

console.log(`Account: @${account.username}`);
console.log(`Scanning ${tweets.length.toLocaleString()} tweets across ${Object.values(CATEGORIES).flat().length} patterns...\n`);

const hits = [];
const categoryCounts = {};

for (const tweet of tweets) {
  const text = tweet.full_text;
  const isRT = text.startsWith('RT @');

  for (const [category, patterns] of Object.entries(CATEGORIES)) {
    for (const regex of patterns) {
      const matched = extractHitTerm(text, regex);
      if (matched) {
        hits.push({
          id: tweet.id_str,
          date: new Date(tweet.created_at).toISOString().slice(0, 10),
          category,
          matchedTerm: matched,
          isRT,
          isReply: !!tweet.in_reply_to_status_id_str,
          replyTo: tweet.in_reply_to_screen_name || null,
          text,
          xcancelUrl: `https://xcancel.com/${account.username}/status/${tweet.id_str}`,
        });
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
        break; // one hit per category per tweet is enough to flag
      }
    }
  }
}

// Summary
console.log('=== Summary ===');
const sortedCats = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
for (const [cat, count] of sortedCats) {
  console.log(`  ${cat.padEnd(25)} ${count}`);
}
console.log(`  ${'TOTAL flagged tweets'.padEnd(25)} ${hits.length}`);

// RT breakdown — often people flag things because someone else said it
const rtHits = hits.filter(h => h.isRT).length;
const originalHits = hits.length - rtHits;
console.log(`\n  (of which: ${originalHits} original, ${rtHits} in RTs of others)`);

// By year
const byYear = new Map();
for (const h of hits) {
  const y = h.date.slice(0, 4);
  byYear.set(y, (byYear.get(y) || 0) + 1);
}
console.log('\n  Flag count by year:');
for (const [y, c] of [...byYear.entries()].sort()) {
  console.log(`    ${y}: ${c}`);
}

writeFileSync(outFile, JSON.stringify({
  account: account.username,
  scannedTweets: tweets.length,
  totalHits: hits.length,
  categoryCounts,
  hits: hits.sort((a, b) => a.date.localeCompare(b.date)),
}, null, 2));
console.log(`\nFull report: ${outFile}`);
