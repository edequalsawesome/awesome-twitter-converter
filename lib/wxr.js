import { tweetToHtml, buildReplyContext, mergeThread, parseTwitterDate, formatWpDate, generateSlug } from './converter.js';
import { basename, extname } from 'path';

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webp': 'image/webp',
};

/**
 * Escape XML special characters.
 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate full WXR XML document.
 */
export function generateWxr(items, options = {}) {
  const {
    siteTitle = 'Twitter Archive Import',
    siteUrl = 'https://example.com',
    authorLogin = 'admin',
    authorDisplayName = '',
    authorEmail = '',
  } = options;

  const header = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
  <title>${escapeXml(siteTitle)}</title>
  <link>${escapeXml(siteUrl)}</link>
  <description>Imported from Twitter archive</description>
  <language>en</language>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>${escapeXml(siteUrl)}</wp:base_site_url>
  <wp:base_blog_url>${escapeXml(siteUrl)}</wp:base_blog_url>

  <wp:author>
    <wp:author_login><![CDATA[${authorLogin}]]></wp:author_login>
    <wp:author_email><![CDATA[${authorEmail}]]></wp:author_email>
    <wp:author_display_name><![CDATA[${authorDisplayName}]]></wp:author_display_name>
  </wp:author>

`;

  const footer = `
</channel>
</rss>`;

  return header + items.join('\n') + footer;
}

/**
 * Build a WXR <item> for a post (tweet or merged thread).
 */
let wxrIdCounter = 1;
export function nextWxrId() {
  return wxrIdCounter++;
}
export function resetWxrIdCounter() {
  wxrIdCounter = 1;
}

export function buildPostItem(content, tweet, options = {}) {
  const {
    postType = 'post',
    postFormat = 'aside',
    status = 'publish',
    authorLogin = 'admin',
    tags = [],
    categories = [],
    mediaItems = [],
    wxrPostId,
  } = options;

  if (!wxrPostId) {
    throw new Error('buildPostItem requires options.wxrPostId');
  }

  const date = parseTwitterDate(tweet.created_at);
  const wpDate = formatWpDate(date);
  const slug = generateSlug(content, tweet.id_str);

  // Build inline images for local media
  let mediaHtml = '';
  if (mediaItems.length > 0) {
    const images = mediaItems.filter(m => m.type !== 'video');
    const videos = mediaItems.filter(m => m.type === 'video');

    if (images.length > 0) {
      mediaHtml += '\n\n' + images.map(m =>
        `<!-- wp:image -->\n<figure class="wp-block-image"><img src="${escapeXml(m.importUrl)}" alt="" /></figure>\n<!-- /wp:image -->`
      ).join('\n');
    }
    if (videos.length > 0) {
      mediaHtml += '\n\n' + videos.map(m =>
        `<!-- wp:video -->\n<figure class="wp-block-video"><video src="${escapeXml(m.importUrl)}" controls></video></figure>\n<!-- /wp:video -->`
      ).join('\n');
    }
  }

  const fullContent = content + mediaHtml;

  // Category terms
  const categoryItems = categories.map(cat =>
    `    <category domain="category" nicename="${escapeXml(slugifyTerm(cat))}"><![CDATA[${cat}]]></category>`
  ).join('\n');

  // Tag terms
  const tagItems = tags.map(tag =>
    `    <category domain="post_tag" nicename="${escapeXml(slugifyTerm(tag))}"><![CDATA[${tag}]]></category>`
  ).join('\n');

  // Post format term
  const formatTerm = postFormat
    ? `    <category domain="post_format" nicename="post-format-${postFormat}"><![CDATA[${postFormat}]]></category>`
    : '';

  // Post meta for original tweet ID
  const tweetMeta = `
    <wp:postmeta>
      <wp:meta_key><![CDATA[_twitter_tweet_id]]></wp:meta_key>
      <wp:meta_value><![CDATA[${tweet.id_str}]]></wp:meta_value>
    </wp:postmeta>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_twitter_original_url]]></wp:meta_key>
      <wp:meta_value><![CDATA[https://twitter.com/${options.ownerUsername || 'i'}/status/${tweet.id_str}]]></wp:meta_value>
    </wp:postmeta>`;

  return `  <item>
    <title></title>
    <link>${escapeXml(options.siteUrl || 'https://example.com')}/?p=${tweet.id_str}</link>
    <pubDate>${date.toUTCString()}</pubDate>
    <dc:creator><![CDATA[${authorLogin}]]></dc:creator>
    <guid isPermaLink="false">${escapeXml(options.siteUrl || 'https://example.com')}/?p=${tweet.id_str}</guid>
    <description></description>
    <content:encoded><![CDATA[${fullContent}]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>${wxrPostId}</wp:post_id>
    <wp:post_date>${wpDate}</wp:post_date>
    <wp:post_date_gmt>${wpDate}</wp:post_date_gmt>
    <wp:post_modified>${wpDate}</wp:post_modified>
    <wp:post_modified_gmt>${wpDate}</wp:post_modified_gmt>
    <wp:comment_status>closed</wp:comment_status>
    <wp:ping_status>closed</wp:ping_status>
    <wp:post_name>${escapeXml(slug)}</wp:post_name>
    <wp:status>${status}</wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:menu_order>0</wp:menu_order>
    <wp:post_type>${postType}</wp:post_type>
    <wp:is_sticky>0</wp:is_sticky>
${formatTerm}
${categoryItems}
${tagItems}
${tweetMeta}
  </item>`;
}

function slugifyTerm(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build a WXR <item> for a media attachment.
 */
export function buildAttachmentItem(mediaFile, parentWxrPostId, options = {}) {
  const filename = basename(mediaFile.filename);
  const ext = extname(filename).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  const wxrPostId = nextWxrId();
  const importUrl = `${options.mediaBaseUrl || 'tweets_media/'}${filename}`;

  return {
    xml: `  <item>
    <title>${escapeXml(filename)}</title>
    <link>${escapeXml(importUrl)}</link>
    <pubDate></pubDate>
    <dc:creator><![CDATA[${options.authorLogin || 'admin'}]]></dc:creator>
    <guid isPermaLink="false">${escapeXml(importUrl)}</guid>
    <description></description>
    <content:encoded><![CDATA[]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>${wxrPostId}</wp:post_id>
    <wp:post_type>attachment</wp:post_type>
    <wp:status>inherit</wp:status>
    <wp:post_parent>${parentWxrPostId}</wp:post_parent>
    <wp:attachment_url>${escapeXml(importUrl)}</wp:attachment_url>
    <wp:postmeta>
      <wp:meta_key><![CDATA[_wp_attached_file]]></wp:meta_key>
      <wp:meta_value><![CDATA[twitter-import/${filename}]]></wp:meta_value>
    </wp:postmeta>
  </item>`,
    importUrl,
    type: ext === '.mp4' ? 'video' : 'image',
  };
}
