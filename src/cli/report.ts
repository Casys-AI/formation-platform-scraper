#!/usr/bin/env node

/**
 * Generate extraction status report in Markdown
 * Analyzes lesson JSON files and generates comprehensive status report
 */

import { Command } from 'commander';
import { readdir, readFile, writeFile } from 'fs/promises';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { deduplicateMedia } from '../media-handler.js';
import { loadConfig } from '../config.js';
import type { MediaContent } from '../types.js';

interface LessonStatus {
  id: string;
  title: string;
  type: string;
  chapter: number;
  hasContent: boolean;
  hasFormatting: boolean;  // fullContentFormatted + summary + keywords
  formattingComplete: number;  // Count of completed formatting fields (0-3)
  formattingTotal: number;     // Total formatting fields expected (always 3)
  mediaCount: number;
  mediaDownloaded: number;
  mediaTranscribed: number;
  mediaErrors: number;
  status: 'complete' | 'partial' | 'failed' | 'missing';
}

interface ChapterStats {
  number: number;
  title: string;
  totalLessons: number;
  extractedLessons: number;
  completeLessons: number;
  partialLessons: number;
  failedLessons: number;
  totalMedia: number;
  downloadedMedia: number;
  transcribedMedia: number;
  formattingComplete: number;  // Count of lessons with complete formatting
  formattingTotal: number;      // Total lessons requiring formatting
  errors: LessonStatus[];
}

interface GlobalStats {
  totalLessons: number;
  extractedLessons: number;
  completeLessons: number;
  partialLessons: number;
  failedLessons: number;
  missingLessons: number;
  totalMedia: number;
  downloadedMedia: number;
  transcribedMedia: number;
  chapters: ChapterStats[];
  generatedAt: string;
}

/**
 * Analyze a lesson JSON file and extract status
 */
async function analyzeLessonFile(filePath: string): Promise<LessonStatus | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lesson = JSON.parse(content);

    // Deduplicate media (remove MP3 if video exists)
    const originalMedia = lesson.media || [];
    const deduplicatedMedia = deduplicateMedia(originalMedia as MediaContent[]);

    const mediaCount = deduplicatedMedia.length;
    const mediaDownloaded = deduplicatedMedia.filter((m: any) => m.downloaded === true).length;
    const mediaTranscribed = deduplicatedMedia.filter((m: any) => m.transcribed === true).length;
    const mediaErrors = deduplicatedMedia.filter((m: any) => m.transcribed === null || m.transcribed === false).length;

    // Check individual formatting fields
    const formattingFields = {
      fullContentFormatted: !!lesson.fullContentFormatted,
      summary: !!lesson.summary,
      keywords: !!lesson.keywords
    };
    const formattingComplete = Object.values(formattingFields).filter(v => v === true).length;
    const formattingTotal = 3;
    const hasFormatting = formattingComplete === formattingTotal;

    // Determine lesson status (media + formatting)
    let status: 'complete' | 'partial' | 'failed' | 'missing' = 'missing';
    if (lesson.content && lesson.content.mainContent) {
      // Check media completion
      const mediaComplete = mediaCount === 0 ||
        (mediaDownloaded === mediaCount && mediaTranscribed === mediaCount);

      if (mediaComplete && hasFormatting) {
        status = 'complete'; // All media + formatting complete
      } else if (mediaComplete && mediaCount === 0) {
        // Special case: no media, but check if formatting exists
        status = hasFormatting ? 'complete' : 'partial';
      } else if (mediaComplete && !hasFormatting) {
        status = 'partial'; // Media OK but formatting missing
      } else if (mediaDownloaded > 0 || mediaTranscribed > 0) {
        status = 'partial'; // Some media processed
      } else {
        status = 'failed'; // No media processed
      }
    }

    return {
      id: lesson.metadata?.id || lesson.content?.id || 'unknown',
      title: lesson.metadata?.title || lesson.content?.title || 'Untitled',
      type: lesson.metadata?.type || lesson.content?.type || '?',
      chapter: lesson.chapter?.number || 0,
      hasContent: !!lesson.content?.mainContent,
      hasFormatting,
      formattingComplete,
      formattingTotal,
      mediaCount,
      mediaDownloaded,
      mediaTranscribed,
      mediaErrors,
      status,
    };
  } catch (error) {
    console.error(chalk.red(`Failed to analyze ${filePath}:`), error);
    return null;
  }
}

/**
 * Scan lessons directory and analyze all chapters
 */
async function scanLessons(
  lessonsDir: string,
  filterChapter?: number,
  configChapters?: number[]
): Promise<ChapterStats[]> {
  const chapters: Map<number, ChapterStats> = new Map();

  // Read chapter directories
  const entries = await readdir(lessonsDir, { withFileTypes: true });
  const chapterDirs = entries
    .filter(e => e.isDirectory() && e.name.startsWith('chapter-'))
    .map(e => {
      const num = parseInt(e.name.replace('chapter-', ''), 10);
      return { num, dir: e.name };
    })
    .filter(c => {
      // Command-line filter takes priority
      if (filterChapter) return c.num === filterChapter;
      // Otherwise use config filter if available
      if (configChapters && configChapters.length > 0) return configChapters.includes(c.num);
      // No filter - include all
      return true;
    })
    .sort((a, b) => a.num - b.num);

  for (const { num, dir } of chapterDirs) {
    const chapterPath = join(lessonsDir, dir);
    const files = await readdir(chapterPath);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    const lessons: LessonStatus[] = [];
    for (const file of jsonFiles) {
      const filePath = join(chapterPath, file);
      const status = await analyzeLessonFile(filePath);
      if (status) {
        lessons.push(status);
      }
    }

    // Calculate chapter stats
    const completeLessons = lessons.filter(l => l.status === 'complete').length;
    const partialLessons = lessons.filter(l => l.status === 'partial').length;
    const failedLessons = lessons.filter(l => l.status === 'failed').length;
    const totalMedia = lessons.reduce((sum, l) => sum + l.mediaCount, 0);
    const downloadedMedia = lessons.reduce((sum, l) => sum + l.mediaDownloaded, 0);
    const transcribedMedia = lessons.reduce((sum, l) => sum + l.mediaTranscribed, 0);
    const formattingComplete = lessons.filter(l => l.hasFormatting).length;
    const formattingTotal = lessons.length; // All lessons require formatting
    const errors = lessons.filter(l => l.status === 'failed' || l.status === 'partial');

    chapters.set(num, {
      number: num,
      title: lessons[0]?.title.split(':')[0]?.trim() || `Chapter ${num}`,
      totalLessons: jsonFiles.length,
      extractedLessons: lessons.length,
      completeLessons,
      partialLessons,
      failedLessons,
      totalMedia,
      downloadedMedia,
      transcribedMedia,
      formattingComplete,
      formattingTotal,
      errors,
    });
  }

  return Array.from(chapters.values());
}

/**
 * Generate global statistics from chapter stats
 */
function calculateGlobalStats(chapters: ChapterStats[]): GlobalStats {
  const totalLessons = chapters.reduce((sum, c) => sum + c.totalLessons, 0);
  const extractedLessons = chapters.reduce((sum, c) => sum + c.extractedLessons, 0);
  const completeLessons = chapters.reduce((sum, c) => sum + c.completeLessons, 0);
  const partialLessons = chapters.reduce((sum, c) => sum + c.partialLessons, 0);
  const failedLessons = chapters.reduce((sum, c) => sum + c.failedLessons, 0);
  const totalMedia = chapters.reduce((sum, c) => sum + c.totalMedia, 0);
  const downloadedMedia = chapters.reduce((sum, c) => sum + c.downloadedMedia, 0);
  const transcribedMedia = chapters.reduce((sum, c) => sum + c.transcribedMedia, 0);

  return {
    totalLessons,
    extractedLessons,
    completeLessons,
    partialLessons,
    failedLessons,
    missingLessons: totalLessons - extractedLessons,
    totalMedia,
    downloadedMedia,
    transcribedMedia,
    chapters,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate Markdown report
 */
function generateMarkdownReport(stats: GlobalStats, courseSlug: string): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${courseSlug} - Extraction Status Report`);
  lines.push('');
  lines.push(`**Generated:** ${new Date(stats.generatedAt).toLocaleString()}`);
  lines.push('');

  // Global Statistics
  lines.push('## 📊 Global Statistics');
  lines.push('');
  lines.push(`- **Total Lessons:** ${stats.totalLessons}`);
  lines.push(`- **Extracted:** ${stats.extractedLessons} (${((stats.extractedLessons / stats.totalLessons) * 100).toFixed(1)}%)`);
  lines.push(`- **Complete:** ${stats.completeLessons} ✅`);
  lines.push(`- **Partial:** ${stats.partialLessons} ⚠️`);
  lines.push(`- **Failed:** ${stats.failedLessons} ❌`);
  lines.push(`- **Missing:** ${stats.missingLessons}`);
  lines.push('');
  lines.push(`- **Total Media:** ${stats.totalMedia}`);
  lines.push(`- **Downloaded:** ${stats.downloadedMedia} (${stats.totalMedia > 0 ? ((stats.downloadedMedia / stats.totalMedia) * 100).toFixed(1) : 0}%)`);
  lines.push(`- **Transcribed:** ${stats.transcribedMedia} (${stats.totalMedia > 0 ? ((stats.transcribedMedia / stats.totalMedia) * 100).toFixed(1) : 0}%)`);
  lines.push('');

  // Chapter Details
  lines.push('## 📖 Chapter Details');
  lines.push('');

  for (const chapter of stats.chapters) {
    const completionPct = (chapter.extractedLessons / chapter.totalLessons) * 100;
    const statusEmoji = completionPct === 100 && chapter.failedLessons === 0 && chapter.partialLessons === 0
      ? '✅'
      : chapter.failedLessons > 0 || chapter.partialLessons > 0
      ? '⚠️'
      : '🔄';

    lines.push(`### ${statusEmoji} Chapter ${chapter.number}`);
    lines.push('');
    lines.push(`- **Lessons:** ${chapter.extractedLessons}/${chapter.totalLessons} (${completionPct.toFixed(1)}%)`);
    lines.push(`- **Complete:** ${chapter.completeLessons} | **Partial:** ${chapter.partialLessons} | **Failed:** ${chapter.failedLessons}`);
    lines.push(`- **Media:** ${chapter.downloadedMedia}/${chapter.totalMedia} downloaded, ${chapter.transcribedMedia}/${chapter.totalMedia} transcribed`);
    lines.push(`- **Formatting:** ${chapter.formattingComplete}/${chapter.formattingTotal} complete`);
    lines.push('');

    // Show errors if any
    if (chapter.errors.length > 0) {
      lines.push('#### ⚠️ Issues');
      lines.push('');
      for (const error of chapter.errors) {
        const issues: string[] = [];

        // Media issue
        if (error.mediaCount > 0) {
          const mediaComplete = error.mediaTranscribed === error.mediaCount;
          if (!mediaComplete) {
            issues.push(`Media: ${error.mediaTranscribed}/${error.mediaCount} transcribed`);
          }
        }

        // Formatting issue
        if (!error.hasFormatting) {
          issues.push('Formatting: missing');
        }

        const issueText = issues.length > 0 ? ` - ${issues.join(', ')}` : '';
        lines.push(`- **${error.id}:** ${error.title}${issueText}`);
      }
      lines.push('');
    }
  }

  // Summary
  lines.push('---');
  lines.push('');
  lines.push('## 📝 Summary');
  lines.push('');
  if (stats.failedLessons === 0 && stats.partialLessons === 0 && stats.extractedLessons === stats.totalLessons) {
    lines.push('✅ **All lessons extracted successfully!**');
  } else if (stats.failedLessons > 0) {
    lines.push(`⚠️ **${stats.failedLessons} lessons failed** - re-run extraction to retry.`);
  } else if (stats.partialLessons > 0) {
    lines.push(`⚠️ **${stats.partialLessons} lessons partially extracted** - some media failed.`);
  } else {
    lines.push(`🔄 **Extraction in progress:** ${stats.extractedLessons}/${stats.totalLessons} lessons extracted.`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Main command
 */
const program = new Command();

program
  .name('report')
  .description('Generate extraction status report in Markdown')
  .argument('[course-slug]', 'Course slug (auto-detected from config if not provided)')
  .argument('[config-path]', 'Config file path (default: extraction-config.json)', 'extraction-config.json')
  .option('-c, --chapter <number>', 'Filter by chapter number (overrides config)')
  .option('-o, --output <path>', 'Output file path (default: output/{slug}/REPORT.md)')
  .action(async (courseSlugArg: string | undefined, configPath: string, options: { chapter?: string; output?: string }) => {
    try {
      console.log(chalk.blue.bold('\n📊 Generating Extraction Status Report...\n'));

      // Load config first to extract slug if not provided
      let courseSlug = courseSlugArg;
      let filterChapter: number | undefined;
      let configChapters: number[] | undefined;

      try {
        const config = loadConfig(configPath);
        console.log(chalk.gray(`Config loaded: mode=${config.mode}, chapters=${config.chapters?.join(',') || 'all'}`));

        // Extract slug from formationUrl if not provided as argument
        if (!courseSlug) {
          courseSlug = config.formationUrl.split('/').pop() || '';
          console.log(chalk.gray(`Auto-detected slug from config: ${courseSlug}`));
        }

        // If mode is 'chapters', use the configured chapters
        if (config.mode === 'chapters' && config.chapters && config.chapters.length > 0) {
          configChapters = config.chapters;
          console.log(chalk.gray(`Filtering by chapters from config: ${configChapters.join(', ')}`));
        }
      } catch (error) {
        console.warn(chalk.yellow(`⚠️ Could not load config (${configPath}), scanning all chapters`));
      }

      // Validate courseSlug was determined
      if (!courseSlug) {
        console.error(chalk.red(`❌ Could not determine course slug. Please provide it as argument or check config file.`));
        process.exit(1);
      }

      // Construct paths
      const outputDir = resolve(process.cwd(), 'output', courseSlug);
      const lessonsDir = join(outputDir, 'lessons');

      // Check if lessons directory exists
      if (!existsSync(lessonsDir)) {
        console.error(chalk.red(`❌ Lessons directory not found: ${lessonsDir}`));
        process.exit(1);
      }

      // Command-line option overrides config
      if (options.chapter) {
        filterChapter = parseInt(options.chapter, 10);
        console.log(chalk.gray(`Command-line filter: chapter ${filterChapter}`));
      }

      // Scan lessons
      console.log(chalk.gray(`Scanning lessons in: ${lessonsDir}`));
      const chapters = await scanLessons(lessonsDir, filterChapter, configChapters);

      if (chapters.length === 0) {
        console.error(chalk.red('❌ No chapters found'));
        process.exit(1);
      }

      // Calculate global stats
      const stats = calculateGlobalStats(chapters);

      // Generate report
      const reportMd = generateMarkdownReport(stats, courseSlug);

      // Save report
      const reportPath = options.output
        ? resolve(process.cwd(), options.output)
        : join(outputDir, 'REPORT.md');

      await writeFile(reportPath, reportMd, 'utf-8');

      console.log(chalk.green.bold(`✅ Report generated: ${reportPath}\n`));

      // Print summary
      console.log(chalk.cyan('Summary:'));
      console.log(chalk.gray(`  Total Lessons: ${stats.totalLessons}`));
      console.log(chalk.gray(`  Extracted: ${stats.extractedLessons} (${((stats.extractedLessons / stats.totalLessons) * 100).toFixed(1)}%)`));
      console.log(chalk.gray(`  Complete: ${stats.completeLessons} ✅`));
      console.log(chalk.gray(`  Partial: ${stats.partialLessons} ⚠️`));
      console.log(chalk.gray(`  Failed: ${stats.failedLessons} ❌`));
      console.log(chalk.gray(`  Media: ${stats.transcribedMedia}/${stats.totalMedia} transcribed`));
      console.log('');

    } catch (error) {
      console.error(chalk.red('❌ Failed to generate report:'), error);
      process.exit(1);
    }
  });

program.parse();
