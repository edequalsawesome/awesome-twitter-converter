/**
 * Convert tweet entities into formatted HTML content.
 */

const LINK_DOMAIN = 'xcancel.com';

/**
 * Process a tweet's full_text using its entities to produce HTML.
 * Replaces @mentions with links, expands t.co URLs, removes media URLs,
 * and converts hashtags to links.
 */
export function tweetToHtml(tweet, options = {}) {
  const linkDomain = options.linkDomain || LINK_DOMAIN;
  let text = tweet.full_text;

  // Collect all entity replacements, sorted by index descending
  // so we can replace from end to start without shifting indices
  const replacements = [];

  // @mentions → links
  if (tweet.entities?.user_mentions) {
    for (const mention of tweet.entities.user_mentions) {
      const start = parseInt(mention.indices[0]);
      const end = parseInt(mention.indices[1]);
      const url = `https://${linkDomain}/${mention.screen_name}`;
      replacements.push({
        start,
        end,
        replacement: `<a href="${url}">@${mention.screen_name}</a>`,
      });
    }
  }

  // URLs → expanded
  if (tweet.entities?.urls) {
    for (const urlEntity of tweet.entities.urls) {
      const start = parseInt(urlEntity.indices[0]);
      const end = parseInt(urlEntity.indices[1]);
      const expanded = urlEntity.expanded_url || urlEntity.url;
      const display = urlEntity.display_url || expanded;
      replacements.push({
        start,
        end,
        replacement: `<a href="${expanded}">${display}</a>`,
      });
    }
  }

  // Media URLs → remove from text (we'll attach them separately)
  if (tweet.entities?.media) {
    for (const media of tweet.entities.media) {
      const start = parseInt(media.indices[0]);
      const end = parseInt(media.indices[1]);
      replacements.push({
        start,
        end,
        replacement: '', // remove; media handled as attachments or inline images
      });
    }
  }

  // Hashtags → links (to the tag archive on the target site)
  if (tweet.entities?.hashtags) {
    for (const hashtag of tweet.entities.hashtags) {
      const start = parseInt(hashtag.indices[0]);
      const end = parseInt(hashtag.indices[1]);
      replacements.push({
        start,
        end,
        replacement: `#${hashtag.text}`,
      });
    }
  }

  // Sort descending by start index and apply
  replacements.sort((a, b) => b.start - a.start);
  for (const rep of replacements) {
    text = text.slice(0, rep.start) + rep.replacement + text.slice(rep.end);
  }

  // Clean up whitespace
  text = text.trim();

  // Convert newlines to <br> for HTML
  text = text.replace(/\n/g, '\n');

  return text;
}

/**
 * Build reply context line for a tweet that's a reply.
 */
export function buildReplyContext(tweet, options = {}) {
  const linkDomain = options.linkDomain || LINK_DOMAIN;

  if (!tweet.in_reply_to_status_id_str) return '';

  const screenName = tweet.in_reply_to_screen_name || 'unknown';
  const tweetUrl = `https://${linkDomain}/${screenName}/status/${tweet.in_reply_to_status_id_str}`;

  return `<p class="tweet-reply-context"><small>In reply to <a href="${tweetUrl}">@${screenName}</a></small></p>\n\n`;
}

/**
 * Merge a thread (array of tweets) into a single HTML block.
 */
export function mergeThread(threadTweets, options = {}) {
  const parts = [];

  for (let i = 0; i < threadTweets.length; i++) {
    const tweet = threadTweets[i];
    let html = tweetToHtml(tweet, options);

    // Strip leading self-mention from thread continuations
    if (i > 0) {
      html = html.replace(/^<a[^>]*>@\w+<\/a>\s*/, '');
    }

    parts.push(html);
  }

  // If the first tweet in the thread is itself a reply to someone else, add context
  const firstTweet = threadTweets[0];
  let replyPrefix = '';
  if (firstTweet.in_reply_to_status_id_str && !isPartOfOwnThread(firstTweet, threadTweets)) {
    replyPrefix = buildReplyContext(firstTweet, options);
  }

  return replyPrefix + parts.join('\n\n---\n\n');
}

function isPartOfOwnThread(tweet, threadTweets) {
  return threadTweets.some(t => t.id_str === tweet.in_reply_to_status_id_str);
}

/**
 * Parse Twitter's date format into a Date object.
 * Format: "Sun Jul 09 18:04:16 +0000 2023"
 */
export function parseTwitterDate(dateStr) {
  return new Date(dateStr);
}

/**
 * Format a Date as WordPress-style datetime: "2023-07-09 18:04:16"
 */
export function formatWpDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * Generate a slug from tweet content (first few words).
 */
export function generateSlug(text, tweetId) {
  // Strip HTML tags
  const plain = text.replace(/<[^>]+>/g, '').trim();
  const words = plain.split(/\s+/).slice(0, 6);
  const slug = words
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || `tweet-${tweetId}`;
}

/**
 * Get media items for a tweet from the local media map.
 */
export function getLocalMedia(tweet, mediaMap) {
  const files = mediaMap.get(tweet.id_str) || [];

  // Also try to match via media entity id_str
  const entityMedia = tweet.extended_entities?.media || tweet.entities?.media || [];
  const results = [];

  for (const entity of entityMedia) {
    // Skip media from other tweets (retweet media)
    if (entity.source_status_id_str) continue;

    // Find local file by matching tweet ID prefix
    const localFile = files.find(f => {
      // Files are named: tweetId-mediaHash.ext
      return true; // all files matching this tweet ID are relevant
    });

    results.push({
      entity,
      localFiles: files,
      type: entity.type, // photo, video, animated_gif
      url: entity.media_url_https,
    });
  }

  return { entities: entityMedia.filter(e => !e.source_status_id_str), localFiles: files };
}
