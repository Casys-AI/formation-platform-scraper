/**
 * List available chapters from course structure
 * Helps user decide which chapters to extract
 */

import { loadCourseStructure } from '../discovery.js';
import { UI } from '../utils/ui.js';
import chalk from 'chalk';

async function main() {
  try {
    UI.clear();
    UI.section('📚 AVAILABLE CHAPTERS');

    const structure = await loadCourseStructure();

    UI.stats({
      'Course': structure.title,
      'Total Chapters': structure.chapters.length,
      'Total Lessons': structure.totalLessons,
    });

    UI.newLine();
    console.log(chalk.bold('Chapters:'));
    UI.newLine();

    for (const chapter of structure.chapters) {
      const titlePreview = UI.chapterPreview(chapter);
      const typesSummary = UI.lessonTypesSummary(chapter.lessons);

      console.log(chalk.cyan(`  [${chapter.number}]`) + ` ${titlePreview}`);
      console.log(chalk.gray(`      └─ ${chapter.lessons.length} lessons: ${typesSummary}`));
      UI.newLine();
    }

    UI.section('💡 USAGE');

    console.log('To extract specific chapters, edit extraction-config.json:');
    UI.newLine();
    console.log(chalk.gray('{'));
    console.log(chalk.gray('  "mode": "chapters",'));
    console.log(chalk.yellow('  "chapters": [1, 2, 3],') + chalk.gray('  // <-- Add chapter numbers here'));
    console.log(chalk.gray('  ...'));
    console.log(chalk.gray('}'));
    UI.newLine();

    console.log('Then run:');
    console.log(chalk.cyan('  pnpm extract'));
    UI.newLine();

    UI.section('📝 SAMPLE CONFIGURATIONS');

    console.log(chalk.bold('Extract first 3 chapters:'));
    console.log(chalk.gray(JSON.stringify({
      mode: 'chapters',
      chapters: structure.chapters.slice(0, 3).map(c => c.number),
    }, null, 2)));
    UI.newLine();

    console.log(chalk.bold('Extract all chapters:'));
    console.log(chalk.gray(JSON.stringify({
      mode: 'chapters',
      chapters: structure.chapters.map(c => c.number),
    }, null, 2)));
    UI.newLine();

  } catch (error) {
    UI.error(`Failed to list chapters: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
