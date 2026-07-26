import { describe, it, expect } from 'vitest';
import { sanitizeUrl, sanitizeFilename, sanitizeLessonId } from '../src/sanitizer.js';

describe('sanitizeUrl', () => {
  it.each([
    ['javascript:alert(1)'],
    ['JAVASCRIPT:alert(1)'], // protocol match is case-insensitive
    ['data:text/html;base64,xx'],
    ['vbscript:msgbox(1)'],
    ['file:///etc/passwd'],
    ['about:blank'],
  ])('blocks dangerous protocol %s', (url) => {
    expect(sanitizeUrl(url)).toBe('');
  });

  it('blocks empty and whitespace-only URLs', () => {
    expect(sanitizeUrl('')).toBe('');
    expect(sanitizeUrl('   ')).toBe('');
  });

  it('passes through a normal http URL untouched', () => {
    expect(sanitizeUrl('http://example.com/path')).toBe('http://example.com/path');
  });

  it('passes through a normal https URL and trims whitespace', () => {
    expect(sanitizeUrl('  https://example.com/path?q=1  ')).toBe('https://example.com/path?q=1');
  });

  it('allows mailto: and tel: links', () => {
    expect(sanitizeUrl('mailto:test@example.com')).toBe('mailto:test@example.com');
    expect(sanitizeUrl('tel:+123456789')).toBe('tel:+123456789');
  });

  it('allows protocol-relative and root-relative URLs', () => {
    expect(sanitizeUrl('//example.com/path')).toBe('//example.com/path');
    expect(sanitizeUrl('/relative/path')).toBe('/relative/path');
  });

  it.each([
    ['ftp://evil.example.com/payload'],
    ['intent://scan/#Intent;scheme=x;end'],
    ['chrome://settings'],
    ['custom-scheme:payload'],
  ])('rejects any scheme outside the allowlist: %s', (url) => {
    expect(sanitizeUrl(url)).toBe('');
  });

  it('keeps a scheme-less relative path', () => {
    expect(sanitizeUrl('page.html')).toBe('page.html');
  });
});

describe('sanitizeFilename', () => {
  it('keeps a nominal filename unchanged', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  });

  it('strips path traversal / path separators down to the basename', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  });

  it('removes null bytes and control characters', () => {
    expect(sanitizeFilename('file\x00name.txt')).toBe('filename.txt');
  });

  it('prefixes Windows-reserved device names with an underscore', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt');
  });

  it('throws on empty input', () => {
    expect(() => sanitizeFilename('')).toThrow('Invalid filename: must be a non-empty string');
  });

  it('throws when sanitization strips the filename down to nothing', () => {
    expect(() => sanitizeFilename('...')).toThrow(
      'Sanitized filename is empty - original may have been malicious'
    );
  });
});

describe('sanitizeLessonId', () => {
  it('keeps a nominal lesson id unchanged', () => {
    expect(sanitizeLessonId('lesson-123_abc')).toBe('lesson-123_abc');
  });

  it('strips characters outside alphanumerics/hyphen/underscore', () => {
    expect(sanitizeLessonId('lesson<script>123')).toBe('lessonscript123');
  });

  it('throws on empty input', () => {
    expect(() => sanitizeLessonId('')).toThrow('Invalid lesson ID: must be a non-empty string');
  });

  it('throws when sanitization strips the id down to nothing', () => {
    expect(() => sanitizeLessonId('!!!')).toThrow(
      'Invalid lesson ID format: must contain alphanumerics, hyphens, or underscores'
    );
  });
});
