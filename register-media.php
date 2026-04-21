<?php
/**
 * WP-CLI script to register already-copied media files as WordPress attachments
 * and attach them to their parent tweet posts via _twitter_tweet_id meta.
 *
 * Usage: wp eval-file register-media.php --path=/path/to/wordpress
 *
 * Prerequisites:
 * - Media files already copied to wp-content/uploads/twitter-import/
 * - Posts already imported via WXR with _twitter_tweet_id meta
 */

if ( ! defined( 'ABSPATH' ) ) {
	echo "Run this with: wp eval-file register-media.php\n";
	exit( 1 );
}

$upload_dir  = wp_upload_dir();
$media_dir   = $upload_dir['basedir'] . '/twitter-import';
$media_url   = $upload_dir['baseurl'] . '/twitter-import';

if ( ! is_dir( $media_dir ) ) {
	WP_CLI::error( "Media directory not found: $media_dir" );
}

// Build map of tweet_id => post_id from imported posts
WP_CLI::log( 'Building tweet ID → post ID map...' );
global $wpdb;
$meta_rows = $wpdb->get_results(
	"SELECT post_id, meta_value FROM $wpdb->postmeta WHERE meta_key = '_twitter_tweet_id'"
);

$tweet_to_post = array();
foreach ( $meta_rows as $row ) {
	$tweet_to_post[ $row->meta_value ] = (int) $row->post_id;
}
WP_CLI::log( sprintf( 'Found %d imported tweet posts.', count( $tweet_to_post ) ) );

// Scan media directory
$files     = scandir( $media_dir );
$attached  = 0;
$skipped   = 0;
$orphaned  = 0;

$mime_types = array(
	'jpg'  => 'image/jpeg',
	'jpeg' => 'image/jpeg',
	'png'  => 'image/png',
	'gif'  => 'image/gif',
	'mp4'  => 'video/mp4',
	'webp' => 'image/webp',
);

foreach ( $files as $filename ) {
	if ( $filename[0] === '.' ) {
		continue;
	}

	$filepath = $media_dir . '/' . $filename;
	if ( ! is_file( $filepath ) ) {
		continue;
	}

	// Extract tweet ID from filename: {tweet_id}-{hash}.{ext}
	$parts    = explode( '-', $filename, 2 );
	$tweet_id = $parts[0];

	// Check if already registered
	$existing = $wpdb->get_var( $wpdb->prepare(
		"SELECT ID FROM $wpdb->posts WHERE post_type = 'attachment' AND guid LIKE %s",
		'%' . $wpdb->esc_like( $filename )
	) );

	if ( $existing ) {
		$skipped++;
		continue;
	}

	// Find parent post
	$parent_id = isset( $tweet_to_post[ $tweet_id ] ) ? $tweet_to_post[ $tweet_id ] : 0;

	if ( ! $parent_id ) {
		$orphaned++;
	}

	// Determine MIME type
	$ext       = strtolower( pathinfo( $filename, PATHINFO_EXTENSION ) );
	$mime_type = isset( $mime_types[ $ext ] ) ? $mime_types[ $ext ] : 'application/octet-stream';

	// Register as attachment
	$attachment = array(
		'post_mime_type' => $mime_type,
		'post_title'     => pathinfo( $filename, PATHINFO_FILENAME ),
		'post_content'   => '',
		'post_status'    => 'inherit',
		'guid'           => $media_url . '/' . $filename,
	);

	$attach_id = wp_insert_attachment( $attachment, 'twitter-import/' . $filename, $parent_id );

	if ( is_wp_error( $attach_id ) ) {
		WP_CLI::warning( "Failed to register: $filename - " . $attach_id->get_error_message() );
		continue;
	}

	// Generate metadata (dimensions, etc.)
	if ( file_exists( ABSPATH . 'wp-admin/includes/image.php' ) ) {
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$metadata = wp_generate_attachment_metadata( $attach_id, $filepath );
		wp_update_attachment_metadata( $attach_id, $metadata );
	}

	$attached++;

	if ( $attached % 50 === 0 ) {
		WP_CLI::log( sprintf( '  Registered %d media files...', $attached ) );
	}
}

WP_CLI::success( sprintf(
	'Done! Registered: %d | Skipped (existing): %d | Orphaned (no parent post): %d',
	$attached,
	$skipped,
	$orphaned
) );
