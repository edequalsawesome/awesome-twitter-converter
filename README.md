# awesome-twitter-converter

Convert a Twitter/X archive into WordPress WXR XML for import.

Built to import 10,000+ tweets into a WordPress site as drafts, with threads
merged, replies tagged for easy filtering, media attached, and every post
carrying the original tweet ID as post meta so re-imports dedupe cleanly.

## What it does

- **Parses** the `tweets.js` + `tweets_media/` folder from an official Twitter
  archive ZIP
- **Merges threads** (self-reply chains) into single posts with `---` separators
- **Preserves reply context** ("In reply to @user") linking to
  [xcancel.com](https://xcancel.com) — the privacy-friendly X mirror
- **Attaches local media** (images, videos, gifs) that ship with the archive
- **Skips retweets by default** (RTs of other people's tweets aren't really
  your content); opt in with `--include-retweets`
- **Tags** each hashtag as a WP tag; optionally tags replies-to-others with a
  configurable marker tag (default `reply`) so you can filter them from
  front-page feeds
- **Year-by-year batching** via `--year` for large archives that choke the WP
  importer in one shot
- **Stores** `_twitter_tweet_id` + `_twitter_original_url` as post meta for
  stable dedupe on re-imports

Output is [WXR 1.2](https://wordpress.org/support/article/tools-export-screen/)
XML, importable via the standard `wordpress-importer` plugin or `wp import` CLI.

## Quickstart

```bash
# 1. Install
git clone https://github.com/edequalsawesome/awesome-twitter-converter.git
cd awesome-twitter-converter
npm install

# 2. Unzip your Twitter archive into a folder
unzip twitter-YYYY-MM-DD-xxx.zip -d /path/to/my-archive

# 3. Convert (one year at a time is recommended for large archives)
node index.js /path/to/my-archive \
  --year 2019 \
  --output 2019.xml \
  --site-url https://your-wordpress-site.com \
  --author your-wp-username \
  --category "Twitter"

# 4. Import into WordPress
#    Admin: Tools → Import → WordPress → upload 2019.xml
#    CLI:   wp import 2019.xml --authors=create
```

For bulk per-year imports on WordPress Studio, see `scripts/rollout.sh`.

## Options

```
--output <file>             Output WXR path (default: twitter-import.xml)
--include-retweets          Include retweets (default: skip)
--post-type <type>          WP post type (default: post)
--post-format <format>      WP post format (default: aside)
--post-status <status>      publish | draft | private (default: draft)
--link-domain <domain>      Domain for @mentions / tweet links (default: xcancel.com)
--site-url <url>            Target WordPress site URL
--author <login>            WP author login (default: admin)
--category <name...>        Categories to apply to every post (default: Twitter)
--reply-tag <tag>           Tag applied to replies-to-others (default: reply)
--year <YYYY>               Only include tweets from this year
--after <YYYY-MM-DD>        Only tweets after this date
--before <YYYY-MM-DD>       Only tweets before this date
--skip-ids <file>           Path to a newline-separated list of tweet IDs to exclude
--copy-media                Copy media files to an output dir alongside the WXR
--media-base-url <url>      Base URL for media references (default: tweets_media/)
--serve-media [port]        Start a local HTTP server for media during import (port: 8787)
--no-merge-threads          Keep thread tweets as separate posts
--skip-replies              Skip replies to other users entirely
```

## Content audit (`scripts/audit.js`)

Ten-plus years of tweets = some stuff you probably wouldn't say today. Not
because you were a bad person — because norms shifted, terms that used to be
casual are now widely understood as slurs, and "funny" jokes age differently
than you'd expect.

This script scans your archive for:

- Named slurs (racial, homophobic, transphobic, ableist) and misogynistic language
- "I hate [group]" and "kill all [group]" patterns
- Rape and suicide jokes

It outputs a JSON report with every hit, the matched term, the tweet date, and
an xcancel link for context.

**It does NOT delete anything.** It flags candidates for you to review before
you publish. Use `--skip-ids` on the converter with a list of IDs you decide
to leave out.

**Expect a lot of false positives.** "Cracker" hits Cracker Barrel. "Kill
yourself" hits movie reviews ("this movie makes you want to kill yourself").
"Rape Me" is a Nirvana song. The regexes are wide on purpose — a tool that
misses real hits is worse than one that shows you harmless ones, because
you're going to eye each match anyway.

**It's a safety net for pre-publish review, not a moral audit.** You still
decide. The point is to make sure you see everything worth seeing before
N thousand old posts go public.

```bash
node scripts/audit.js /path/to/my-archive audit-report.json
# → Summary to stdout, full hits (with tweet text + xcancel URL) in the JSON.
# Then: jq '.hits[] | select(.category == "homophobic-slur") | .id' audit-report.json > skip.txt
# Then: node index.js ... --skip-ids skip.txt
```

## Media handling

The Twitter archive includes local copies of every image/video you posted in
`data/tweets_media/` (filenames are `<tweet_id>-<hash>.<ext>`). The converter
emits `<wp:attachment>` items for each one and uses `<wp:attachment_url>` as
the fetch URL for the WP importer to sideload.

Three ways to resolve those URLs at import time:

1. **`--serve-media`** (easiest for local/Studio imports) — runs an HTTP server
   on port 8787 next to the conversion; the WP importer fetches files from
   `http://localhost:8787/<filename>`.
2. **Pre-copy + `--media-base-url`** — copy `tweets_media/*` to somewhere the
   WP site can reach (e.g. `wp-content/uploads/twitter-import/`) and set
   `--media-base-url` to the URL that serves them. The importer downloads from
   that URL and sideloads into the site's normal uploads tree.
3. **`register-media.php`** — companion WP-CLI script that registers files
   already placed in uploads as attachments without the importer fetching them.
   Useful if network fetches from the importer are blocked.

Note: the WP importer sideloads into `wp-content/uploads/<today>/<today>/`,
not the tweet's original year/month. For most personal archives this is fine;
if you care, see the `wp-importer-sideload-current-date` entry in this author's
Claude Code skills or patch the importer yourself.

## Re-imports are safe

Every post stores the original tweet ID as `_twitter_tweet_id` post meta. To
dedupe before a re-import, query existing IDs:

```bash
wp post meta list --meta_key=_twitter_tweet_id --format=csv \
  | awk -F, 'NR>1 {print $3}' > already-imported.txt
```

Then pass that as `--skip-ids`.

## License

MIT. See LICENSE.
