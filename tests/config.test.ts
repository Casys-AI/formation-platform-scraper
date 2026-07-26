import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadConfig,
  describeConfig,
  applyEnvOverrides,
  type ExtractionConfig,
} from '../src/config.js';

function baseConfig(): ExtractionConfig {
  return {
    formationUrl: 'https://example.com/course',
    mode: 'all',
    chapters: [],
    types: [],
    lessonIds: [],
    rateLimit: { delayMs: 2000, enableRateLimit: true },
    output: { saveJson: true, saveMarkdown: true },
    filters: { skipQuizzes: true, skipAncChapters: true, allowedTypes: [] },
    media: { skipMedia: false, skipTranscribe: false, skipScreenshots: false },
    formatting: { skipFormatting: false, model: 'gpt-4.1' },
  };
}

// applyEnvOverrides and loadConfig both read process.env, so isolate the
// three recognized env vars around every test in this file.
const ENV_KEYS = ['DELAY_BETWEEN_PAGES_MS', 'DOWNLOAD_MEDIA', 'TRANSCRIBE_MEDIA'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('describeConfig', () => {
  it('describes chapters mode', () => {
    const config: ExtractionConfig = { ...baseConfig(), mode: 'chapters', chapters: [1, 2, 3] };
    expect(describeConfig(config)).toBe('Extracting chapters: 1, 2, 3');
  });

  it('describes types mode', () => {
    const config: ExtractionConfig = { ...baseConfig(), mode: 'types', types: ['📚', '✍️'] };
    expect(describeConfig(config)).toBe('Extracting types: 📚, ✍️');
  });

  it('describes specific-lessons mode', () => {
    const config: ExtractionConfig = {
      ...baseConfig(),
      mode: 'specific-lessons',
      lessonIds: ['a', 'b', 'c'],
    };
    expect(describeConfig(config)).toBe('Extracting specific lessons: 3 lesson(s)');
  });

  it('describes all mode', () => {
    const config: ExtractionConfig = { ...baseConfig(), mode: 'all' };
    expect(describeConfig(config)).toBe('Extracting ALL lessons from the course');
  });
});

describe('applyEnvOverrides', () => {
  it('maps DELAY_BETWEEN_PAGES_MS to rateLimit.delayMs', () => {
    process.env.DELAY_BETWEEN_PAGES_MS = '500';
    const config = baseConfig();
    applyEnvOverrides(config);
    expect(config.rateLimit.delayMs).toBe(500);
  });

  it('fails fast on a non-numeric DELAY_BETWEEN_PAGES_MS', () => {
    process.env.DELAY_BETWEEN_PAGES_MS = 'not-a-number';
    const config = baseConfig();
    expect(() => applyEnvOverrides(config)).toThrow(/Invalid DELAY_BETWEEN_PAGES_MS/);
  });

  it('sets media.skipMedia when DOWNLOAD_MEDIA=false', () => {
    process.env.DOWNLOAD_MEDIA = 'false';
    const config = baseConfig();
    applyEnvOverrides(config);
    expect(config.media.skipMedia).toBe(true);
  });

  it('leaves media.skipMedia false when DOWNLOAD_MEDIA=true', () => {
    process.env.DOWNLOAD_MEDIA = 'true';
    const config = baseConfig();
    applyEnvOverrides(config);
    expect(config.media.skipMedia).toBe(false);
  });

  it('sets media.skipTranscribe when TRANSCRIBE_MEDIA=false', () => {
    process.env.TRANSCRIBE_MEDIA = 'false';
    const config = baseConfig();
    applyEnvOverrides(config);
    expect(config.media.skipTranscribe).toBe(true);
  });

  it('leaves unrelated config fields untouched', () => {
    process.env.DELAY_BETWEEN_PAGES_MS = '750';
    const config = baseConfig();
    applyEnvOverrides(config);
    expect(config.formationUrl).toBe('https://example.com/course');
    expect(config.mode).toBe('all');
  });
});

describe('loadConfig / validateConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fps-config-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(data: unknown): string {
    const path = join(dir, 'extraction-config.json');
    writeFileSync(path, JSON.stringify(data), 'utf-8');
    return path;
  }

  it('rejects dryRun and media.resumeMode used together (mutually exclusive)', () => {
    // media is omitted so it falls back to DEFAULT_CONFIG.media, which has
    // resumeMode: true — combined with dryRun: true this must be rejected.
    const path = writeConfig({
      formationUrl: 'https://example.com/course',
      mode: 'all',
      dryRun: true,
    });
    expect(() => loadConfig(path)).toThrow('Cannot use resumeMode with dryRun (mutually exclusive)');
  });

  it('rejects an empty formationUrl', () => {
    const path = writeConfig({
      formationUrl: '',
      mode: 'all',
    });
    expect(() => loadConfig(path)).toThrow('formationUrl is required and must be a non-empty string');
  });

  it('accepts a valid config', () => {
    const path = writeConfig({
      formationUrl: 'https://example.com/course',
      mode: 'chapters',
      chapters: [1, 2, 3],
      media: {
        skipMedia: false,
        skipTranscribe: false,
        skipScreenshots: false,
        resumeMode: false,
      },
    });

    const config = loadConfig(path);

    expect(config.formationUrl).toBe('https://example.com/course');
    expect(config.mode).toBe('chapters');
    expect(config.chapters).toEqual([1, 2, 3]);
  });
});
