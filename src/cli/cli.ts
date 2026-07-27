#!/usr/bin/env node
/**
 * Main CLI entry point for the Formation Platform Scraper
 * Provides interactive menu and command-line interface
 */

import 'dotenv/config';
import { program } from 'commander';
import { select, confirm } from '@inquirer/prompts';
import { execa } from 'execa';
import { UI } from '../utils/ui.js';
import { authenticate } from '../auth.js';
import { discoverCourseStructure } from '../discovery.js';
import { loadConfig } from '../config.js';

/**
 * Run discovery command
 */
async function discoverCommand() {
  try {
    UI.clear();
    UI.showTitle('Course Discovery');

    const spinner = UI.spinner('Loading configuration...');
    spinner.start();

    // Load configuration to get formation URL
    const configPath = process.argv[3] || 'extraction-config.json';
    const config = loadConfig(configPath);

    spinner.text = 'Authenticating and discovering course structure...';

    // Get credentials from environment
    const email = process.env.FORMATION_EMAIL;
    const password = process.env.FORMATION_PASSWORD;

    if (!email || !password) {
      spinner.stop();
      UI.error('Missing credentials in .env file');
      UI.info('Required: FORMATION_EMAIL, FORMATION_PASSWORD');
      process.exit(1);
    }

    // Authenticate
    const browser = await authenticate({ email, password }, config.formationUrl);

    spinner.text = 'Extracting course structure...';

    // Run discovery with formation URL from config
    const structure = await discoverCourseStructure(browser, config.formationUrl, { maxChapters: undefined });

    // Cleanup
    await browser.disconnect();

    spinner.stop();

    UI.success('Course structure discovered and saved!');
    UI.newLine();
    UI.stats({
      'Course': structure.title,
      'Chapters': structure.chapters.length,
      'Total Lessons': structure.totalLessons,
      'Saved to': 'output/course-structure.json',
    });

  } catch (error) {
    UI.error(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Run list chapters command
 */
async function listChaptersCommand() {
  try {
    await execa('npx', ['tsx', 'src/cli/list-chapters.ts'], { stdio: 'inherit' });
  } catch (error) {
    UI.error(`Failed to list chapters: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Run select chapters command
 */
async function selectChaptersCommand() {
  try {
    await execa('npx', ['tsx', 'src/cli/select-chapters.ts'], { stdio: 'inherit' });
  } catch (error) {
    UI.error(`Failed to select chapters: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Run extraction command
 */
async function extractCommand() {
  try {
    await execa('npx', ['tsx', 'src/cli/extract.ts'], { stdio: 'inherit' });
  } catch (error) {
    UI.error(`Failed to extract: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Run link health check command
 */
async function checkLinksCommand() {
  try {
    await execa('npx', ['tsx', 'src/cli/check-links.ts'], { stdio: 'inherit' });
  } catch (error) {
    UI.error(`Failed to check links: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Run knowledge graph generation command
 */
async function knowledgeGraphCommand(courseSlug?: string) {
  try {
    const args = ['npx', 'tsx', 'src/cli/knowledge-graph.ts'];
    if (courseSlug) {
      args.push(courseSlug);
    }
    await execa(args[0], args.slice(1), { stdio: 'inherit' });
  } catch (error) {
    UI.error(`Failed to generate knowledge graph: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Interactive main menu
 */
async function mainMenu(): Promise<void> {
  UI.clear();
  UI.showTitle();

  const action = await select({
    message: 'What would you like to do?',
    choices: [
      { name: '🔍 Discover Course Structure', value: 'discover' },
      { name: '📚 List Available Chapters', value: 'list' },
      { name: '✅ Select Chapters to Extract', value: 'select' },
      { name: '🚀 Run Extraction', value: 'extract' },
      { name: '🔗 Check Broken Links', value: 'check-links' },
      { name: '📊 Generate Knowledge Graph', value: 'knowledge-graph' },
      { name: '❌ Exit', value: 'exit' },
    ],
  });

  switch (action) {
    case 'discover':
      await discoverCommand();
      break;
    case 'list':
      await listChaptersCommand();
      break;
    case 'select':
      await selectChaptersCommand();
      break;
    case 'extract':
      await extractCommand();
      break;
    case 'check-links':
      await checkLinksCommand();
      break;
    case 'knowledge-graph':
      await knowledgeGraphCommand();
      break;
    case 'exit':
      UI.success('Goodbye! 👋');
      process.exit(0);
  }

  // Ask if user wants to continue
  if (action !== 'exit') {
    UI.newLine();
    const continueAction = await confirm({
      message: 'Would you like to perform another action?',
      default: false,
    });

    if (continueAction) {
      await mainMenu();
    } else {
      UI.success('Goodbye! 👋');
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  program
    .name('scraper')
    .description('Formation Platform Scraper - Extract course content with media and links')
    .version('1.0.0');

  // Define commands
  program
    .command('discover')
    .description('Discover and save course structure from the platform')
    .action(discoverCommand);

  program
    .command('list')
    .description('List available chapters from saved course structure')
    .action(listChaptersCommand);

  program
    .command('select')
    .description('Interactively select chapters to extract')
    .action(selectChaptersCommand);

  program
    .command('extract')
    .description('Run extraction based on extraction-config.json')
    .action(extractCommand);

  program
    .command('check-links')
    .description('Check health of all external links in lesson content')
    .action(checkLinksCommand);

  program
    .command('knowledge-graph [courseSlug]')
    .alias('kg')
    .description('Generate pedagogical knowledge graph from extracted lessons')
    .action(knowledgeGraphCommand);

  // If no command provided, show interactive menu
  if (process.argv.length < 3) {
    await mainMenu();
  } else {
    await program.parseAsync(process.argv);
  }
}

// Handle errors
main().catch((error) => {
  if (error && typeof error === 'object' && 'message' in error &&
      (error.message as string).includes('User force closed')) {
    UI.success('Goodbye! 👋');
  } else {
    UI.error(String(error));
  }
  process.exit(0);
});
