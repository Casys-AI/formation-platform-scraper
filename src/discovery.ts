/**
 * Story 4: Discovery - Extract Course Structure
 *
 * Extracts the complete course structure (chapters + lessons) from the
 * Teachizy formation index page using evaluate() to access the browser DOM directly.
 *
 * ARCHITECTURE DECISION:
 * - ❌ NOT using Cheerio + snapshot() - snapshot() returns YAML accessibility tree, not HTML
 * - ✅ USING evaluate() - Direct DOM access via browser JavaScript, proven to work (11 chapters found)
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { Browser } from './browser.js';
import type { CourseStructure, Chapter, LessonMetadata } from './types.js';
import { createLogger } from './utils.js';
import { TIMEOUTS, VALIDATION, EMOJI_PATTERN } from './constants.js';

const logger = createLogger('discovery');

// Constants
const OUTPUT_DIR = 'output';

/**
 * Main discovery function - extracts complete course structure
 *
 * @param browser Authenticated browser with active session
 * @param formationUrl URL of the formation index page to scrape
 * @param options Optional configuration
 * @returns Complete course structure with chapters and lessons
 */
export async function discoverCourseStructure(
  browser: Browser,
  formationUrl: string,
  options: { maxChapters?: number } = {}
): Promise<CourseStructure> {
  const { maxChapters } = options;

  // Validate maxChapters parameter
  if (maxChapters !== undefined) {
    if (!Number.isInteger(maxChapters) || maxChapters < 1) {
      throw new Error(`maxChapters must be a positive integer, got: ${maxChapters}`);
    }
  }

  logger.info('🔍 Starting course structure discovery');

  try {
    // 1. Navigate to index page
    logger.info({ url: formationUrl }, 'Navigating to index page');
    await browser.navigate(formationUrl);

    // 2. Wait for page load - CRITICAL: Content loads dynamically!
    logger.info(`⏳ Waiting for page load (${TIMEOUTS.PAGE_LOAD}ms for dynamic content)`);
    await browser.waitFor({ timeout: TIMEOUTS.PAGE_LOAD });

    // 3. Extract structure using evaluate() - runs in browser context
    logger.info('📊 Extracting structure from DOM using evaluate()');
    const rawStructure = await extractStructureFromDOM(browser, options.maxChapters);

    // 4. Process and enrich with slug - Extract from URL instead of generating from title
    // URL format: .../mon-espace/formations/{course-slug}
    const urlObj = new URL(formationUrl);
    const pathParts = urlObj.pathname.split('/').filter((p) => p);
    const formationsIdx = pathParts.indexOf('formations');

    if (formationsIdx === -1 || pathParts.length <= formationsIdx + 1) {
      throw new Error(`Could not extract course slug from URL: ${formationUrl}`);
    }

    const courseSlug = pathParts[formationsIdx + 1];
    logger.info({ courseSlug, extractedFrom: 'URL' }, 'Course slug extracted');

    const structure: CourseStructure = {
      ...rawStructure,
      slug: courseSlug,
      origin: urlObj.origin,
      scrapedAt: new Date(rawStructure.scrapedAt),
    };

    logger.debug(
      {
        totalChapters: structure.chapters.length,
        totalLessons: structure.totalLessons,
      },
      'Raw structure extracted'
    );

    // 5. Validate
    logger.info('✅ Validating structure');
    validateStructure(structure);

    // 6. Save to JSON
    logger.info('💾 Saving structure to disk');
    await saveStructure(structure);

    logger.info(
      {
        totalChapters: structure.chapters.length,
        totalLessons: structure.totalLessons,
      },
      '✅ Course structure discovered successfully'
    );

    return structure;
  } catch (error) {
    logger.error({ error }, '❌ Discovery failed');
    throw error;
  }
}

/**
 * Extract course structure from browser DOM using evaluate()
 *
 * This runs JavaScript directly in the browser context to access the real DOM,
 * not a YAML accessibility tree like snapshot() returns.
 *
 * @param browser browser with loaded page
 * @param maxChapters Optional limit on chapters to extract (for testing)
 * @returns Parsed course structure
 */
async function extractStructureFromDOM(
  browser: Browser,
  maxChapters?: number
): Promise<CourseStructure> {
  logger.info('📊 Extracting structure from DOM');

  // Execute extraction script in browser context
  const result = await browser.evaluate(`
    (() => {
      // Extract course title from page
      const courseTitle = document.querySelector('h1')?.textContent?.trim() || 'Formation';

      const chapters = [];

      // Find all h2 headings with panel-heading class (captures ALL chapters including emoji-only titles)
      const chapterHeadings = Array.from(document.querySelectorAll('h2.panel-heading'));

      // Limit chapters if specified (for testing)
      const chaptersToProcess = ${maxChapters} ? chapterHeadings.slice(0, ${maxChapters}) : chapterHeadings;

      chaptersToProcess.forEach((h2, idx) => {
        const title = h2.textContent?.trim() || '';
        const lessons = [];

        // Get the panel containing this h2
        const currentPanel = h2.closest('.panel');

        // STEP 1: Find lessons within the current panel (siblings of h2)
        let sibling = h2.nextElementSibling;
        while (sibling && sibling.tagName !== 'H2') {
          // Find all lesson links in this section
          const links = sibling.querySelectorAll('a[href*="/elements/"]');
          links.forEach(link => {
            const href = link.getAttribute('href');
            const lessonTitle = link.textContent?.trim() || '';
            const idMatch = href?.match(/elements\\/(\\d+)/);

            if (idMatch && lessonTitle) {
              // Extract emoji (first emoji character found)
              // Using explicit alternation to avoid Unicode surrogate pair issues
              const emojiMatch = lessonTitle.match(/(📚|✍️|🧠|🔥|📔)/);
              const type = emojiMatch ? emojiMatch[0] : '';

              // Extract quiz questions count
              const quizMatch = lessonTitle.match(/(\\d+)\\s+Questions?/i);
              const quizQuestions = quizMatch ? parseInt(quizMatch[1]) : 0;

              // Extract annexes count
              const annexesMatch = lessonTitle.match(/(\\d+)\\s+Annexes?/i);
              const annexesCount = annexesMatch ? parseInt(annexesMatch[1]) : 0;

              // Build full URL
              const fullUrl = href?.startsWith('http')
                ? href
                : location.origin + href;

              lessons.push({
                id: idMatch[1],
                title: lessonTitle,
                type: type,
                url: fullUrl,
                hasQuiz: lessonTitle.includes('Question'),
                quizQuestions: quizQuestions,
                annexesCount: annexesCount
              });
            }
          });
          sibling = sibling.nextElementSibling;
        }

        // STEP 2: Find "orphan" panels without h2 between this panel and the next panel with h2
        // These are panels that visually belong to this chapter but don't have their own h2
        if (currentPanel) {
          let nextPanel = currentPanel.nextElementSibling;
          while (nextPanel) {
            // Stop if we find a panel with an h2 (next chapter)
            const hasH2 = nextPanel.querySelector('h2.panel-heading');
            if (hasH2) break;

            // Check if this is a panel without h2
            if (nextPanel.classList.contains('panel')) {
              // Find all lesson links in this orphan panel
              const links = nextPanel.querySelectorAll('a[href*="/elements/"]');
              links.forEach(link => {
                const href = link.getAttribute('href');
                const lessonTitle = link.textContent?.trim() || '';
                const idMatch = href?.match(/elements\\/(\\d+)/);

                if (idMatch && lessonTitle) {
                  const emojiMatch = lessonTitle.match(/(📚|✍️|🧠|🔥|📔)/);
                  const type = emojiMatch ? emojiMatch[0] : '';
                  const quizMatch = lessonTitle.match(/(\\d+)\\s+Questions?/i);
                  const quizQuestions = quizMatch ? parseInt(quizMatch[1]) : 0;
                  const annexesMatch = lessonTitle.match(/(\\d+)\\s+Annexes?/i);
                  const annexesCount = annexesMatch ? parseInt(annexesMatch[1]) : 0;
                  const fullUrl = href?.startsWith('http')
                    ? href
                    : location.origin + href;

                  lessons.push({
                    id: idMatch[1],
                    title: lessonTitle,
                    type: type,
                    url: fullUrl,
                    hasQuiz: lessonTitle.includes('Question'),
                    quizQuestions: quizQuestions,
                    annexesCount: annexesCount
                  });
                }
              });
            }

            nextPanel = nextPanel.nextElementSibling;
          }
        }

        // Use sequential chapter numbering
        const chapterNumber = idx + 1;

        chapters.push({
          number: chapterNumber,
          title: title,
          lessons: lessons
        });
      });

      return {
        title: courseTitle,
        chapters: chapters,
        totalLessons: chapters.reduce((sum, ch) => sum + ch.lessons.length, 0),
        scrapedAt: new Date().toISOString()
      };
    })()
  `);

  logger.debug(
    {
      chaptersFound: result.chapters.length,
      totalLessons: result.totalLessons,
    },
    'Structure extracted from DOM'
  );

  return result;
}

/**
 * Validate course structure meets expected criteria
 *
 * @param structure Course structure to validate
 * @throws Error if critical validation fails
 */
function validateStructure(structure: CourseStructure): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check total lessons ≈ expected count (with tolerance)
  const expectedLessons = VALIDATION.EXPECTED_LESSONS;
  const tolerance = VALIDATION.LESSON_COUNT_TOLERANCE;
  if (
    structure.totalLessons < expectedLessons - tolerance ||
    structure.totalLessons > expectedLessons + tolerance
  ) {
    warnings.push(
      `Total lessons (${structure.totalLessons}) outside expected range (${expectedLessons} ±${tolerance})`
    );
  }

  // Verify all chapters have at least 1 lesson
  structure.chapters.forEach((ch, idx) => {
    if (ch.lessons.length === 0) {
      errors.push(`Chapter ${idx + 1} "${ch.title}" has no lessons`);
    }
  });

  // Verify all lesson IDs are unique
  const allIds = structure.chapters.flatMap((ch) => ch.lessons.map((l) => l.id));
  const uniqueIds = new Set(allIds);
  if (uniqueIds.size !== allIds.length) {
    errors.push(`Duplicate lesson IDs found (${allIds.length} total, ${uniqueIds.size} unique)`);
  }

  // Verify all URLs are valid format
  const invalidUrls = structure.chapters.flatMap((ch) =>
    ch.lessons.filter((l) => !l.url || !l.url.startsWith('https://'))
  );
  if (invalidUrls.length > 0) {
    errors.push(`${invalidUrls.length} lessons have invalid URLs`);
  }

  // Verify no null/undefined in required fields
  structure.chapters.forEach((ch, chIdx) => {
    if (!ch.title) errors.push(`Chapter ${chIdx + 1} missing title`);
    if (ch.number === undefined) errors.push(`Chapter ${chIdx + 1} missing number`);

    ch.lessons.forEach((lesson, lessonIdx) => {
      if (!lesson.id) errors.push(`Lesson ${chIdx + 1}.${lessonIdx + 1} missing ID`);
      if (!lesson.title) errors.push(`Lesson ${chIdx + 1}.${lessonIdx + 1} missing title`);
      if (!lesson.url) errors.push(`Lesson ${chIdx + 1}.${lessonIdx + 1} missing URL`);
    });
  });

  // Log validation results
  if (warnings.length > 0) {
    logger.warn({ warnings }, '⚠️  Validation warnings');
  }

  if (errors.length > 0) {
    logger.error({ errors }, '❌ Validation errors');
    throw new Error(`Structure validation failed: ${errors.join(', ')}`);
  }

  logger.info(
    {
      chapters: structure.chapters.length,
      lessons: structure.totalLessons,
      uniqueIds: uniqueIds.size,
    },
    '✅ Structure validation passed'
  );
}

/**
 * Save course structure to JSON file
 * Saves in course-specific directory: output/{slug}/course-structure.json
 *
 * @param structure Course structure to save
 */
async function saveStructure(structure: CourseStructure): Promise<void> {
  // Create course-specific directory
  const courseDir = join(OUTPUT_DIR, structure.slug);
  await fs.mkdir(courseDir, { recursive: true });

  const fileName = 'course-structure.json';
  const filePath = join(courseDir, fileName);
  const json = JSON.stringify(structure, null, 2);

  await fs.writeFile(filePath, json, 'utf-8');

  logger.info(
    {
      filePath,
      sizeKB: Math.round(json.length / 1024),
      slug: structure.slug,
    },
    '💾 Structure saved to disk'
  );
}

/**
 * Load course structure from JSON file
 * Looks for course-structure.json in course-specific directories
 *
 * @param slug Optional course slug. If not provided, loads the first course found
 * @returns Loaded course structure
 * @throws Error if no structure file is found
 */
export async function loadCourseStructure(slug?: string): Promise<CourseStructure> {
  try {
    let filePath: string;

    if (slug) {
      // Load specific course by slug
      filePath = join(OUTPUT_DIR, slug, 'course-structure.json');
    } else {
      // Find first course directory containing course-structure.json
      const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
      const courseDirs = entries.filter((entry) => entry.isDirectory());

      let foundDir: string | undefined;
      for (const dir of courseDirs) {
        const potentialPath = join(OUTPUT_DIR, dir.name, 'course-structure.json');
        try {
          await fs.access(potentialPath);
          foundDir = dir.name;
          break;
        } catch {
          // File doesn't exist, continue searching
        }
      }

      if (!foundDir) {
        throw new Error('No course structure file found. Run discovery first.');
      }

      filePath = join(OUTPUT_DIR, foundDir, 'course-structure.json');
    }

    const json = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(json);

    // Deserialize Date field
    data.scrapedAt = new Date(data.scrapedAt);

    logger.info({ filePath, slug: data.slug }, '📂 Structure loaded from disk');
    return data as CourseStructure;
  } catch (error) {
    logger.error({ slug, error }, '❌ Failed to load structure');
    throw error instanceof Error ? error : new Error(String(error));
  }
}
