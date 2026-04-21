#!/usr/bin/env node

import { program } from 'commander';
import { writeFileSync, copyFileSync, mkdirSync, existsSync, createReadStream, readFileSync } from 'fs';
import { join, resolve, extname } from 'path';
import { createServer } from 'http';
import { parseTweetsFile, parseAccountFile, buildMediaMap, categorizeTweets } from './lib/parser.js';
import { tweetToHtml, buildReplyContext, mergeThread, parseTwitterDate } from './lib/converter.js';
import { generateWxr, buildPostItem, buildAttachmentItem, nextWxrId, resetWxrIdCounter } from './lib/wxr.js';

const MIME_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webp': 'image/webp',
};

program
  .name('awesome-twitter-converter')
  .description('Convert a Twitter/X archive into WordPress WXR XML')
  .argument('<archive-path>', 'Path to extracted Twitter archive directory')
  .option('-o, --output <file>', 'Output WXR XML file path', 'twitter-import.xml')
  .option('--include-retweets', 'Include retweets (skipped by default)', false)
  .option('--post-type <type>', 'WordPress post type', 'post')
  .option('--post-format <format>', 'WordPress post format', 'aside')
  .option('--post-status <status>', 'Post status (publish, draft, private)', 'draft')
  .option('--link-domain <domain>', 'Domain for Twitter profile/tweet links', 'xcancel.com')
  .option('--site-url <url>', 'Target WordPress site URL', 'https://example.com')
  .option('--author <login>', 'WordPress author login name', 'admin')
  .option('--copy-media', 'Copy media files to output directory', false)
  .option('--media-base-url <url>', 'Base URL for media in WXR (relative or absolute)', 'tweets_media/')
  .option('--serve-media [port]', 'Start local HTTP server for media files during import (default port: 8787)')
  .option('--merge-threads', 'Merge self-reply threads into single posts (default: true)', true)
  .option('--no-merge-threads', 'Keep thread tweets as separate posts')
  .option('--skip-replies', 'Skip replies to other users', false)
  .option('--reply-tag <tag>', 'Tag to apply to replies so they can be filtered from main feeds (empty = no tag)', 'reply')
  .option('--category <name...>', 'Categories to apply to every imported post (repeatable)', ['Twitter'])
  .option('--year <year>', 'Only include tweets from this year')
  .option('--after <date>', 'Only include tweets after this date (YYYY-MM-DD)')
  .option('--before <date>', 'Only include tweets before this date (YYYY-MM-DD)')
  .option('--skip-ids <file>', 'Path to a file of tweet IDs to exclude (one per line)')
  .action(convert);

program.parse();

function convert(archivePath, options) {
  archivePath = resolve(archivePath);
  resetWxrIdCounter();

  console.log(`\n📂 Reading archive from: ${archivePath}`);

  // Parse the archive
  const account = parseAccountFile(archivePath);
  console.log(`👤 Account: @${account.username} (${account.displayName})`);

  const allTweets = parseTweetsFile(archivePath);
  console.log(`📊 Total tweets in archive: ${allTweets.length.toLocaleString()}`);

  // Apply ID skip list
  let tweets = allTweets;
  if (options.skipIds) {
    const skipPath = resolve(options.skipIds);
    const skipSet = new Set(
      readFileSync(skipPath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    );
    const before = tweets.length;
    tweets = tweets.filter(t => !skipSet.has(t.id_str));
    console.log(`🚫 Skip list: excluded ${before - tweets.length} tweet(s) from ${skipPath}`);
  }

  if (options.year) {
    tweets = tweets.filter(t => {
      const year = parseTwitterDate(t.created_at).getUTCFullYear();
      return year === parseInt(options.year);
    });
    console.log(`📅 Filtered to year ${options.year}: ${tweets.length.toLocaleString()} tweets`);
  }
  if (options.after) {
    const afterDate = new Date(options.after);
    tweets = tweets.filter(t => parseTwitterDate(t.created_at) > afterDate);
    console.log(`📅 After ${options.after}: ${tweets.length.toLocaleString()} tweets`);
  }
  if (options.before) {
    const beforeDate = new Date(options.before);
    tweets = tweets.filter(t => parseTwitterDate(t.created_at) < beforeDate);
    console.log(`📅 Before ${options.before}: ${tweets.length.toLocaleString()} tweets`);
  }

  // Categorize
  const { originals, replies, retweets, threads } = categorizeTweets(tweets, account.username);

  console.log(`\n📋 Breakdown:`);
  console.log(`   Original tweets: ${originals.length.toLocaleString()}`);
  console.log(`   Replies: ${replies.length.toLocaleString()}`);
  console.log(`   Retweets: ${retweets.length.toLocaleString()}`);
  console.log(`   Threads: ${threads.length} (${threads.reduce((a, t) => a + t.length, 0)} tweets merged)`);

  // Build media map
  const mediaMap = buildMediaMap(archivePath);
  const totalMedia = Array.from(mediaMap.values()).flat().length;
  console.log(`\n🖼️  Local media files: ${totalMedia}`);

  // If --serve-media, override mediaBaseUrl to point at local server
  const servePort = options.serveMedia === true ? 8787 : (options.serveMedia ? parseInt(options.serveMedia) : null);
  if (servePort) {
    options.mediaBaseUrl = `http://localhost:${servePort}/`;
  }

  // Convert options
  const convertOpts = {
    linkDomain: options.linkDomain,
    postType: options.postType,
    postFormat: options.postFormat,
    status: options.postStatus,
    authorLogin: options.author,
    siteUrl: options.siteUrl,
    mediaBaseUrl: options.mediaBaseUrl,
    ownerUsername: account.username,
    replyTag: options.replyTag ? String(options.replyTag).trim() : '',
    categories: options.category || [],
  };

  const wxrItems = [];
  let postCount = 0;
  let mediaCount = 0;

  // Process original tweets
  for (const tweet of originals) {
    const result = processTweet(tweet, mediaMap, convertOpts);
    wxrItems.push(...result.items);
    postCount++;
    mediaCount += result.mediaCount;
  }

  // Process replies
  if (!options.skipReplies) {
    for (const tweet of replies) {
      const result = processTweet(tweet, mediaMap, convertOpts, { isReply: true });
      wxrItems.push(...result.items);
      postCount++;
      mediaCount += result.mediaCount;
    }
  }

  // Process threads
  if (options.mergeThreads) {
    for (const thread of threads) {
      const result = processThread(thread, mediaMap, convertOpts);
      wxrItems.push(...result.items);
      postCount++;
      mediaCount += result.mediaCount;
    }
  } else {
    // Treat each tweet in a thread as a separate post
    for (const thread of threads) {
      for (const tweet of thread) {
        const result = processTweet(tweet, mediaMap, convertOpts);
        wxrItems.push(...result.items);
        postCount++;
        mediaCount += result.mediaCount;
      }
    }
  }

  // Process retweets if opted in
  if (options.includeRetweets) {
    for (const tweet of retweets) {
      const result = processTweet(tweet, mediaMap, convertOpts, { isRetweet: true });
      wxrItems.push(...result.items);
      postCount++;
      mediaCount += result.mediaCount;
    }
  }

  // Generate WXR
  const wxr = generateWxr(wxrItems, {
    siteTitle: `${account.displayName}'s Twitter Archive`,
    siteUrl: options.siteUrl,
    authorLogin: options.author,
    authorDisplayName: account.displayName,
    authorEmail: '',
  });

  // Write output
  const outputPath = resolve(options.output);
  writeFileSync(outputPath, wxr, 'utf8');
  console.log(`\n✅ WXR written to: ${outputPath}`);
  console.log(`   Posts: ${postCount.toLocaleString()}`);
  console.log(`   Media attachments: ${mediaCount.toLocaleString()}`);

  // Copy media if requested
  if (options.copyMedia) {
    const mediaOutputDir = join(resolve(outputPath, '..'), 'tweets_media');
    if (!existsSync(mediaOutputDir)) {
      mkdirSync(mediaOutputDir, { recursive: true });
    }

    let copied = 0;
    for (const files of mediaMap.values()) {
      for (const file of files) {
        copyFileSync(file.path, join(mediaOutputDir, file.filename));
        copied++;
      }
    }
    console.log(`   Media files copied: ${copied} → ${mediaOutputDir}`);
  }

  console.log(`\n💡 Import this file using WordPress's built-in WXR importer.`);
  console.log(`   Posts are set to "${options.postStatus}" — review before publishing.`);

  // Start media server if requested
  if (servePort) {
    const mediaDir = join(archivePath, 'data', 'tweets_media');
    startMediaServer(mediaDir, servePort);
  } else {
    console.log('');
  }
}

function startMediaServer(mediaDir, port) {
  let requestCount = 0;

  const server = createServer((req, res) => {
    const filename = decodeURIComponent(req.url.replace(/^\//, ''));
    const filePath = join(mediaDir, filename);

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    requestCount++;

    res.writeHead(200, { 'Content-Type': contentType });
    createReadStream(filePath).pipe(res);

    if (requestCount % 50 === 0) {
      console.log(`   📥 Served ${requestCount} media files...`);
    }
  });

  server.listen(port, () => {
    console.log(`\n🌐 Media server running at http://localhost:${port}/`);
    console.log(`   Serving files from: ${mediaDir}`);
    console.log(`\n   Now go import the WXR file in WordPress.`);
    console.log(`   The importer will download media from this server.`);
    console.log(`   Press Ctrl+C when the import is done.\n`);
  });

  process.on('SIGINT', () => {
    console.log(`\n\n✅ Media server stopped. Served ${requestCount} files total.\n`);
    server.close();
    process.exit(0);
  });
}

function processTweet(tweet, mediaMap, options, flags = {}) {
  const items = [];
  let mediaCount = 0;

  // Reserve this post's WXR ID first so attachments can reference it
  const wxrPostId = nextWxrId();

  // Build content
  let content = '';
  if (flags.isReply) {
    content += buildReplyContext(tweet, options);
  }
  if (flags.isRetweet) {
    content += '<p class="tweet-retweet-context"><small>🔁 Retweet</small></p>\n\n';
  }
  content += tweetToHtml(tweet, options);

  // Handle media
  const mediaFiles = mediaMap.get(tweet.id_str) || [];
  const mediaItems = [];

  for (const file of mediaFiles) {
    const attachment = buildAttachmentItem(file, wxrPostId, options);
    items.push(attachment.xml);
    mediaItems.push(attachment);
    mediaCount++;
  }

  // Extract hashtags as tags, plus reply tag for replies-to-others
  const tags = (tweet.entities?.hashtags || []).map(h => h.text);
  if (flags.isReply && options.replyTag) {
    tags.push(options.replyTag);
  }

  // Build the post item
  items.unshift(buildPostItem(content, tweet, {
    ...options,
    wxrPostId,
    tags,
    categories: options.categories || [],
    mediaItems,
  }));

  return { items, mediaCount };
}

function processThread(threadTweets, mediaMap, options) {
  const items = [];
  let mediaCount = 0;

  // Reserve the thread-post's WXR ID first so attachments can reference it
  const wxrPostId = nextWxrId();

  // Merge thread content
  const content = mergeThread(threadTweets, options);

  // Collect all media from all tweets in thread
  const allMediaItems = [];
  for (const tweet of threadTweets) {
    const mediaFiles = mediaMap.get(tweet.id_str) || [];
    for (const file of mediaFiles) {
      const attachment = buildAttachmentItem(file, wxrPostId, options);
      items.push(attachment.xml);
      allMediaItems.push(attachment);
      mediaCount++;
    }
  }

  // Collect all hashtags from thread
  const tags = [...new Set(
    threadTweets.flatMap(t => (t.entities?.hashtags || []).map(h => h.text))
  )];

  // Use first tweet's metadata for the post
  items.unshift(buildPostItem(content, threadTweets[0], {
    ...options,
    wxrPostId,
    tags,
    categories: options.categories || [],
    mediaItems: allMediaItems,
  }));

  return { items, mediaCount };
}
