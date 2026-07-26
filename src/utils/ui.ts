/* eslint-disable no-console */
import boxen from 'boxen';
import chalk from 'chalk';
import figlet from 'figlet';
import gradient from 'gradient-string';
import ora, { type Ora } from 'ora';
import { table } from 'table';

/**
 * Utility class for beautiful CLI output
 */
export class UI {
  /**
   * Display main title with style
   */
  static showTitle(text: string = 'Formation Scraper'): void {
    const title = figlet.textSync(text, {
      font: 'Standard',
      horizontalLayout: 'default',
    });

    console.log(gradient.pastel.multiline(title));
    console.log(chalk.gray('📚 Extract course content from the formation platform\n'));
  }

  /**
   * Display success message
   */
  static success(message: string): void {
    console.log(chalk.green('✅ ' + message));
  }

  /**
   * Display error message
   */
  static error(message: string): void {
    console.log(chalk.red('❌ ' + message));
  }

  /**
   * Display warning message
   */
  static warning(message: string): void {
    console.log(chalk.yellow('⚠️  ' + message));
  }

  /**
   * Display info message
   */
  static info(message: string): void {
    console.log(chalk.blue('ℹ️  ' + message));
  }

  /**
   * Display progress message
   */
  static progress(message: string): void {
    console.log(chalk.cyan('⏳ ' + message));
  }

  /**
   * Display message in a styled box
   */
  static box(message: string, title?: string): void {
    const options = {
      padding: 1,
      margin: 1,
      borderStyle: 'round' as const,
      borderColor: 'cyan',
      title: title ? chalk.bold.cyan(title) : undefined,
    };

    console.log(boxen(message, options));
  }

  /**
   * Create spinner for long operations
   */
  static spinner(text: string): Ora {
    return ora({
      text: chalk.cyan(text),
      spinner: 'dots12',
    });
  }

  /**
   * Display formatted table
   */
  static table(data: string[][], headers?: string[]): void {
    const tableData = headers ? [headers.map(h => chalk.bold.cyan(h)), ...data] : data;

    console.log(table(tableData));
  }

  /**
   * Display statistics
   */
  static stats(stats: Record<string, string | number>): void {
    const data = Object.entries(stats).map(([key, value]) => [
      chalk.gray(key + ':'),
      chalk.white(String(value)),
    ]);

    this.table(data);
  }

  /**
   * Visual separator
   */
  static separator(): void {
    console.log(chalk.gray('─'.repeat(80)));
  }

  /**
   * Section header
   */
  static section(title: string): void {
    console.log('\n' + chalk.bold.cyan('━'.repeat(80)));
    console.log(chalk.bold.cyan(`  ${title}`));
    console.log(chalk.bold.cyan('━'.repeat(80)) + '\n');
  }

  /**
   * New line
   */
  static newLine(): void {
    console.log();
  }

  /**
   * Clear console
   */
  static clear(): void {
    console.clear();
  }

  /**
   * Display chapter preview (truncated to 60 chars)
   */
  static chapterPreview(chapter: { number: number; title: string; lessons: { type: string }[] }): string {
    const titlePreview = chapter.title.length > 60
      ? chapter.title.substring(0, 60) + '...'
      : chapter.title;

    return titlePreview;
  }

  /**
   * Display lesson types summary
   */
  static lessonTypesSummary(lessons: { type: string }[]): string {
    const typeCounts = lessons.reduce((acc, lesson) => {
      acc[lesson.type] = (acc[lesson.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return Object.entries(typeCounts)
      .map(([type, count]) => `${type}×${count}`)
      .join(' ');
  }
}
