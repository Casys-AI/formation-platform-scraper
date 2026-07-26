/**
 * Interactive chapter selection tool
 * Generates extraction-config.json based on user selection
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { checkbox, confirm } from '@inquirer/prompts';
import { loadCourseStructure } from '../discovery.js';
import { UI } from '../utils/ui.js';
import chalk from 'chalk';
import type { ExtractionConfig } from '../config.js';

async function main() {
  try {
    UI.clear();
    UI.section('📚 CHAPTER SELECTION WIZARD');

    const structure = await loadCourseStructure();

    UI.stats({
      'Course': structure.title,
      'Total Chapters': structure.chapters.length,
      'Total Lessons': structure.totalLessons,
    });

    UI.newLine();

    // Create checkbox choices
    const choices = structure.chapters.map((chapter) => {
      const titlePreview = UI.chapterPreview(chapter);
      const typesSummary = UI.lessonTypesSummary(chapter.lessons);

      return {
        name: `[${chapter.number}] ${titlePreview} (${chapter.lessons.length} lessons: ${typesSummary})`,
        value: chapter.number,
      };
    });

    // Interactive checkbox selection
    const selectedChapters = await checkbox({
      message: 'Select chapters to extract (Space to select, Enter to confirm):',
      choices,
      pageSize: 15,
    });

    if (selectedChapters.length === 0) {
      throw new Error('No chapters selected');
    }

    UI.newLine();
    UI.success(`Selected ${selectedChapters.length} chapter(s): ${selectedChapters.join(', ')}`);

    // Calculate stats
    const selectedLessons = structure.chapters
      .filter((c) => selectedChapters.includes(c.number))
      .reduce((sum, c) => sum + c.lessons.length, 0);

    UI.info(`Total lessons to extract: ${selectedLessons}`);
    UI.newLine();

    // Load or create config
    let config: ExtractionConfig;
    const configPath = 'extraction-config.json';

    try {
      const existingConfig = readFileSync(configPath, 'utf-8');
      config = JSON.parse(existingConfig);
      UI.info('Updating existing config...');
    } catch {
      UI.info('Creating new config...');
      const formationUrl = process.env.FORMATION_URL;
      if (!formationUrl) {
        throw new Error('FORMATION_URL must be set in .env to create a new extraction-config.json');
      }
      config = {
        formationUrl,
        mode: 'chapters',
        chapters: [],
        types: [],
        lessonIds: [],
        rateLimit: {
          delayMs: 2000,
          enableRateLimit: true,
        },
        output: {
          saveJson: true,
          saveMarkdown: true,
        },
        filters: {
          skipQuizzes: true,
          skipAncChapters: true,
          allowedTypes: ['📚', '✍️', '📔', '🧠', '🔥'],
        },
        media: {
          skipMedia: false,
          skipTranscribe: false,
          skipScreenshots: false,
        },
        formatting: {
          skipFormatting: false,
          model: 'gpt-4.1',
        },
      };
    }

    // Update config
    config.mode = 'chapters';
    config.chapters = selectedChapters.sort((a, b) => a - b);

    // Save config
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    UI.success(`Config saved to: ${configPath}`);
    UI.newLine();

    console.log(chalk.bold('Config preview:'));
    console.log(chalk.gray(JSON.stringify(config, null, 2)));

    UI.section('🚀 NEXT STEPS');

    console.log('Run extraction:');
    console.log(chalk.cyan('  pnpm extract'));
    UI.newLine();
    console.log('Or review/edit config first:');
    console.log(chalk.gray(`  cat ${configPath}`));
    UI.newLine();

  } catch (error) {
    if (error && typeof error === 'object' && 'message' in error && error.message === 'User force closed the prompt with 0 null') {
      UI.warning('Selection cancelled by user');
      process.exit(0);
    }
    UI.error(`Selection failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
