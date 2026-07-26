/**
 * Security sanitization utilities
 *
 * Provides functions to prevent XSS, path traversal, and other security vulnerabilities
 */

import { basename } from 'path';

/**
 * Sanitize URL to prevent XSS attacks.
 *
 * Uses a strict allowlist: a URL carrying a scheme is kept only if that scheme
 * is http(s), mailto or tel. Any other scheme (javascript:, data:, vbscript:,
 * file:, about:, ftp:, custom schemes, …) is rejected. Relative and
 * protocol-relative URLs are kept as-is.
 *
 * @param url Raw URL from user content
 * @returns Sanitized URL or empty string if not allowed
 */
export function sanitizeUrl(url: string): string {
  if (!url || typeof url !== 'string') {
    return '';
  }

  const trimmed = url.trim();

  // Block empty or whitespace-only URLs
  if (!trimmed) {
    return '';
  }

  // Protocol-relative (//host/path) and relative (/path, path) URLs are safe.
  if (trimmed.startsWith('//') || trimmed.startsWith('/')) {
    return trimmed;
  }

  // If the URL carries a scheme, it must be on the allowlist.
  // A scheme is: letter followed by letters/digits/+/-/. then ':'.
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch) {
    const safeSchemes = ['http', 'https', 'mailto', 'tel'];
    if (!safeSchemes.includes(schemeMatch[1].toLowerCase())) {
      return ''; // reject javascript:, data:, file:, ftp:, custom schemes, …
    }
    return trimmed;
  }

  // No scheme and not starting with '/': treat as a relative path (e.g. "page.html").
  return trimmed;
}

/**
 * Sanitize text content for markdown output
 *
 * Prevents XSS by escaping HTML entities and dangerous markdown syntax
 *
 * @param text Raw text content
 * @returns Sanitized text safe for markdown
 */
export function sanitizeMarkdownText(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    // Escape HTML entities
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    // Escape dangerous markdown injection attempts
    .replace(/\[javascript:/gi, '[blocked:')
    .replace(/\[data:/gi, '[blocked:')
    .trim();
}

/**
 * Sanitize filename to prevent path traversal attacks
 *
 * Removes:
 * - Path separators (/, \)
 * - Parent directory references (..)
 * - Null bytes
 * - Control characters
 * - Leading/trailing dots and spaces
 *
 * @param filename Raw filename (may contain path traversal attempts)
 * @returns Safe filename containing only alphanumerics, dash, underscore, and single dot
 */
export function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Invalid filename: must be a non-empty string');
  }

  // Extract basename only (removes any path components)
  let safe = basename(filename);

  // Remove null bytes
  safe = safe.replace(/\0/g, '');

  // Remove control characters (ASCII 0-31)
  safe = safe.replace(/[\x00-\x1F]/g, '');

  // Remove dangerous characters
  safe = safe
    .replace(/\.\./g, '') // Parent directory references
    .replace(/[\/\\]/g, '') // Path separators
    .replace(/[<>:"|?*]/g, ''); // Windows forbidden characters

  // Remove leading/trailing dots and spaces
  safe = safe.replace(/^[\s.]+|[\s.]+$/g, '');

  // Ensure result is not empty
  if (!safe || safe.length === 0) {
    throw new Error('Sanitized filename is empty - original may have been malicious');
  }

  // Ensure it's not a reserved name on Windows
  const reservedNames = [
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ];

  const upperSafe = safe.toUpperCase();
  const baseName = upperSafe.split('.')[0];
  if (reservedNames.includes(baseName)) {
    safe = '_' + safe; // Prefix with underscore to avoid reserved name
  }

  return safe;
}

/**
 * Validate and sanitize lesson ID
 *
 * Ensures lesson ID contains only alphanumerics and hyphens
 * Prevents injection attacks through lesson IDs
 *
 * @param lessonId Raw lesson ID
 * @returns Sanitized lesson ID
 * @throws Error if lesson ID is invalid
 */
export function sanitizeLessonId(lessonId: string): string {
  if (!lessonId || typeof lessonId !== 'string') {
    throw new Error('Invalid lesson ID: must be a non-empty string');
  }

  // Allow only alphanumerics, hyphens, and underscores
  const sanitized = lessonId.replace(/[^a-zA-Z0-9\-_]/g, '');

  if (!sanitized || sanitized.length === 0) {
    throw new Error('Invalid lesson ID format: must contain alphanumerics, hyphens, or underscores');
  }

  return sanitized;
}

/**
 * Validate extracted content for completeness and safety
 *
 * @param content Extracted content object
 * @returns Validation errors array (empty if valid)
 */
export function validateExtractedContent(content: {
  title?: string;
  mainContent?: string;
  links?: Array<{ url: string; title: string }>;
  media?: Array<{ url: string; type: string }>;
}): string[] {
  const errors: string[] = [];

  // Check title
  if (!content.title || content.title.trim().length === 0) {
    errors.push('Missing or empty title');
  }

  // Check main content (but allow empty/short content if lesson has media)
  const hasValidMedia = content.media && content.media.length > 0;

  if (!content.mainContent || content.mainContent.trim().length === 0) {
    if (!hasValidMedia) {
      errors.push('Missing or empty main content and no media');
    }
  } else if (content.mainContent.trim().length < 50 && !hasValidMedia) {
    // Validate minimum content length (avoid extracted empty/error pages)
    errors.push('Main content too short and no media - possible extraction error');
  }

  // Validate links
  if (content.links) {
    for (const [index, link] of content.links.entries()) {
      if (!link.url || !sanitizeUrl(link.url)) {
        errors.push(`Link ${index} has invalid or dangerous URL: ${link.url}`);
      }
    }
  }

  // Validate media
  if (content.media) {
    for (const [index, media] of content.media.entries()) {
      if (!media.url || !sanitizeUrl(media.url)) {
        errors.push(`Media ${index} has invalid or dangerous URL: ${media.url}`);
      }
    }
  }

  return errors;
}
