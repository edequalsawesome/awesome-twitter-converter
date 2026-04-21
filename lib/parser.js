import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Parse the Twitter archive tweets.js file.
 * Format: window.YTD.tweets.part0 = [{tweet: {...}}, ...]
 */
export function parseTweetsFile(archivePath) {
  const tweetsPath = join(archivePath, 'data', 'tweets.js');
  if (!existsSync(tweetsPath)) {
    throw new Error(`tweets.js not found at ${tweetsPath}`);
  }

  const raw = readFileSync(tweetsPath, 'utf8');
  const jsonStr = raw.replace(/^window\.YTD\.tweets\.part\d+\s*=\s*/, '');
  const parsed = JSON.parse(jsonStr);

  return parsed.map(entry => entry.tweet);
}

/**
 * Parse account.js to get the archive owner's username.
 */
export function parseAccountFile(archivePath) {
  const accountPath = join(archivePath, 'data', 'account.js');
  if (!existsSync(accountPath)) {
    throw new Error(`account.js not found at ${accountPath}`);
  }

  const raw = readFileSync(accountPath, 'utf8');
  const jsonStr = raw.replace(/^window\.YTD\.account\.part\d+\s*=\s*/, '');
  const parsed = JSON.parse(jsonStr);

  return {
    username: parsed[0].account.username,
    displayName: parsed[0].account.accountDisplayName,
    accountId: parsed[0].account.accountId,
  };
}

/**
 * Build a map of local media files available in the archive.
 * Files are named like: {tweet_id}-{media_hash}.{ext}
 * Returns Map<tweet_id, [{filename, path}]>
 */
export function buildMediaMap(archivePath) {
  const mediaDir = join(archivePath, 'data', 'tweets_media');
  const map = new Map();

  if (!existsSync(mediaDir)) {
    return map;
  }

  const files = readdirSync(mediaDir);
  for (const filename of files) {
    if (filename.startsWith('.')) continue;
    const tweetId = filename.split('-')[0];
    if (!map.has(tweetId)) {
      map.set(tweetId, []);
    }
    map.set(tweetId, [...map.get(tweetId), {
      filename,
      path: join(mediaDir, filename),
    }]);
  }

  return map;
}

/**
 * Categorize tweets into: original, reply, retweet.
 * Detect threads (self-reply chains) and group them.
 */
export function categorizeTweets(tweets, ownerUsername) {
  const tweetMap = new Map();
  for (const tweet of tweets) {
    tweetMap.set(tweet.id_str, tweet);
  }

  const retweets = [];
  const replies = [];
  const originals = [];
  const threadRoots = new Set();
  const threadChildren = new Set();

  // First pass: categorize
  for (const tweet of tweets) {
    if (tweet.full_text.startsWith('RT @')) {
      retweets.push(tweet);
      continue;
    }

    if (tweet.in_reply_to_status_id_str) {
      // Check if it's a self-reply (thread continuation)
      const isThread =
        tweet.in_reply_to_screen_name?.toLowerCase() === ownerUsername.toLowerCase() &&
        tweetMap.has(tweet.in_reply_to_status_id_str);

      if (isThread) {
        threadChildren.add(tweet.id_str);
        // Walk up to find the root
        let current = tweet;
        while (
          current.in_reply_to_status_id_str &&
          current.in_reply_to_screen_name?.toLowerCase() === ownerUsername.toLowerCase() &&
          tweetMap.has(current.in_reply_to_status_id_str)
        ) {
          current = tweetMap.get(current.in_reply_to_status_id_str);
        }
        threadRoots.add(current.id_str);
      } else {
        replies.push(tweet);
      }
      continue;
    }

    originals.push(tweet);
  }

  // Build thread groups: root + ordered children
  const threads = [];
  for (const rootId of threadRoots) {
    const chain = [tweetMap.get(rootId)];
    // Find all descendants in order
    const childrenOfRoot = findThreadChain(rootId, tweets, ownerUsername, tweetMap);
    chain.push(...childrenOfRoot);
    threads.push(chain);
  }

  // Remove thread roots from originals/replies (they'll be in threads)
  const filteredOriginals = originals.filter(t => !threadRoots.has(t.id_str));
  const filteredReplies = replies.filter(t => !threadRoots.has(t.id_str) && !threadChildren.has(t.id_str));

  return {
    originals: filteredOriginals,
    replies: filteredReplies,
    retweets,
    threads,
    tweetMap,
  };
}

/**
 * Given a thread root, find all children in chronological order.
 */
function findThreadChain(rootId, tweets, ownerUsername, tweetMap) {
  // Build parent→children map
  const childMap = new Map();
  for (const tweet of tweets) {
    if (
      tweet.in_reply_to_status_id_str &&
      tweet.in_reply_to_screen_name?.toLowerCase() === ownerUsername.toLowerCase() &&
      tweetMap.has(tweet.in_reply_to_status_id_str)
    ) {
      const parentId = tweet.in_reply_to_status_id_str;
      if (!childMap.has(parentId)) {
        childMap.set(parentId, []);
      }
      childMap.get(parentId).push(tweet);
    }
  }

  // Walk the chain from root
  const result = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const currentId = queue.shift();
    const children = childMap.get(currentId) || [];
    // Sort children by created_at
    children.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    for (const child of children) {
      result.push(child);
      queue.push(child.id_str);
    }
  }

  return result;
}
