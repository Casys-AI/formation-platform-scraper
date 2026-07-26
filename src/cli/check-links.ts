/**
 * Story 9: Broken Links Detection
 * Checks health of all external links in lesson content
 * Generates markdown and JSON reports for analysis and optional AI-powered fixes
 */

import 'dotenv/config';
import { readFile, writeFile, readdir } from 'fs/promises';
import { resolve, join } from 'path';
import pLimit from 'p-limit';
import { createLogger, retry, sleep } from '../utils.js';
import { sanitizeUrl } from '../sanitizer.js';
import type {
  CompleteLesson,
  LinkHealthCheck,
  BrokenLinksReport,
  LessonLinkReport,
} from '../types.js';

const logger = createLogger('link-checker');

/**
 * Find a replacement link using web search via fetch
 * Only called for broken links to suggest alternatives
 */
async function findReplacementLink(
  originalUrl: string,
  linkTitle: string,
  lessonContext?: string
): Promise<{ url: string; title: string; relevanceScore?: number } | null> {
  try {
    const tavilyApiKey = process.env.TAVILY_API_KEY;
    if (!tavilyApiKey) {
      logger.debug('TAVILY_API_KEY not set, skipping replacement search');
      return null;
    }

    // Build search query combining link title and context
    const searchQuery = lessonContext
      ? `${linkTitle} ${lessonContext}`.trim()
      : linkTitle;

    logger.debug({ originalUrl, searchQuery }, 'Searching for replacement link');

    // Call Tavily API
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: searchQuery,
        search_depth: 'basic',
        max_results: 1,
        include_answer: false,
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Tavily API request failed');
      return null;
    }

    const data = await response.json() as {
      results?: Array<{
        url: string;
        title: string;
        score?: number;
      }>;
    };

    if (data.results && data.results.length > 0) {
      const topResult = data.results[0];
      return {
        url: topResult.url,
        title: topResult.title,
        relevanceScore: topResult.score,
      };
    }

    return null;
  } catch (error: any) {
    logger.warn({ error: error.message, originalUrl }, 'Failed to find replacement link');
    return null;
  }
}

/**
 * Configuration for link health checking
 */
interface LinkCheckConfig {
  courseSlug: string;
  concurrency: number;
  timeout: number;
  dryRun: boolean;
  output: {
    saveReport: boolean;
    reportPath: string;
  };
  healthCheck: {
    skipOk: boolean;
    retryFailed: boolean;
    retries: number;
  };
  replacementSearch: {
    enabled: boolean; // Search for replacement links for broken links using Tavily
  };
}

/**
 * JSON export format for Phase 2 (AI fixer)
 */
interface BrokenLinksJSON {
  generatedAt: string;
  courseSlug: string;
  totalLinks: number;
  brokenLinks: number;
  movedLinks: number;
  restrictedLinks: number;
  timeoutLinks: number;
  links: Array<{
    url: string;
    title: string;
    status: string;
    statusCode?: number;
    lessonId: string;
    lessonTitle: string;
    chapterNumber: number;
    chapterTitle: string;
    lessonPath: string;
  }>;
}

/**
 * Check health of a single link via HTTP HEAD request
 * Uses retry logic for resilience and proper timeout handling
 */
async function checkLinkHealth(url: string, timeout = 10000): Promise<LinkHealthCheck> {
  const startTime = Date.now();

  try {
    // Sanitize URL first (security)
    const safeUrl = sanitizeUrl(url);

    // Validate URL format
    new URL(safeUrl);

    // Use retry() utility for resilience
    const response = await retry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          return await fetch(safeUrl, {
            method: 'HEAD',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'User-Agent': 'FormationPlatformScraper/1.0',
            },
          });
        } finally {
          clearTimeout(timeoutId);
        }
      },
      { retries: 1, delay: 500 } // Single retry on network errors
    );

    const responseTime = Date.now() - startTime;
    const statusCode = response.status;

    // Classify response
    if (statusCode >= 200 && statusCode < 300) {
      return { url: safeUrl, status: 'ok', statusCode, responseTime, checkedAt: new Date() };
    }

    if ([301, 302, 307, 308].includes(statusCode)) {
      return {
        url: safeUrl,
        status: 'moved',
        statusCode,
        redirectedTo: response.url,
        responseTime,
        checkedAt: new Date(),
      };
    }

    if ([404, 410].includes(statusCode)) {
      return {
        url: safeUrl,
        status: 'broken',
        statusCode,
        responseTime,
        error: statusCode === 404 ? 'Not Found' : 'Gone',
        checkedAt: new Date(),
      };
    }

    // Anti-bot protection, authentication, rate limiting, method not allowed, temporary unavailable
    // These are NOT broken links - they exist but have access restrictions or temporary issues
    if ([401, 403, 405, 429, 503].includes(statusCode)) {
      const notes: Record<number, string> = {
        401: 'Requires authentication (link exists)',
        403: 'Anti-bot protection (link exists)',
        405: 'Method not allowed (link exists)',
        429: 'Rate limited (link exists)',
        503: 'Service temporarily unavailable (link exists)',
      };
      return {
        url: safeUrl,
        status: 'ok', // ← Treated as OK (link exists, just protected/restricted)
        statusCode,
        responseTime,
        note: notes[statusCode], // ← "note" instead of "error"
        checkedAt: new Date(),
      };
    }

    // Other 4xx/5xx errors (real broken links)
    return {
      url: safeUrl,
      status: 'broken',
      statusCode,
      responseTime,
      error: `HTTP ${statusCode}`,
      checkedAt: new Date(),
    };
  } catch (error: any) {
    const responseTime = Date.now() - startTime;

    if (error.name === 'AbortError') {
      return {
        url,
        status: 'timeout',
        responseTime,
        error: `Timeout (${timeout}ms)`,
        checkedAt: new Date(),
      };
    }

    return {
      url,
      status: 'invalid',
      error: error.message,
      responseTime,
      checkedAt: new Date(),
    };
  }
}

/**
 * Check all links in all lessons for a course
 * Deduplicates URLs and checks each unique link only once
 */
async function checkAllLinks(
  courseSlug: string,
  config: { concurrency: number; timeout: number; replacementSearch: boolean }
): Promise<BrokenLinksReport> {
  logger.info({ courseSlug }, '🔍 Starting link health check');

  // 1. Scan all chapter directories for lesson JSON files
  const baseDir = resolve(process.cwd(), 'output', courseSlug, 'lessons');
  const chapterDirs = (await readdir(baseDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith('chapter-'))
    .map((d) => d.name);

  logger.info({ chapterCount: chapterDirs.length }, `📂 Found ${chapterDirs.length} chapters`);

  // 2. Load all lessons and extract unique links
  const urlToLessons = new Map<string, Array<{ lessonId: string; linkInfo: any; lessonPath: string }>>();
  const allLessons: CompleteLesson[] = [];

  for (const chapterDir of chapterDirs) {
    const chapterPath = join(baseDir, chapterDir);
    const jsonFiles = (await readdir(chapterPath)).filter((f) => f.endsWith('.json') && !f.endsWith('.backup'));

    for (const file of jsonFiles) {
      const lessonPath = join(chapterPath, file);
      const lesson: CompleteLesson = JSON.parse(await readFile(lessonPath, 'utf-8'));
      allLessons.push(lesson);

      // Deduplicate URLs
      for (const link of lesson.content.links) {
        if (!urlToLessons.has(link.url)) {
          urlToLessons.set(link.url, []);
        }
        urlToLessons.get(link.url)!.push({
          lessonId: lesson.metadata.id,
          linkInfo: link,
          lessonPath: `lessons/${chapterDir}/${file}`,
        });
      }
    }
  }

  const uniqueUrls = Array.from(urlToLessons.keys());
  logger.info(
    { totalUrls: uniqueUrls.length, totalLessons: allLessons.length },
    `📊 URLs to check: ${uniqueUrls.length} (from ${allLessons.length} lessons)`
  );

  // 3. Check health with p-limit for concurrency control
  const limit = pLimit(config.concurrency);
  const healthChecks = new Map<string, LinkHealthCheck>();
  let completed = 0;

  const checkPromises = uniqueUrls.map((url) =>
    limit(async () => {
      const health = await checkLinkHealth(url, config.timeout);
      healthChecks.set(url, health);
      completed++;

      if (completed % 10 === 0 || completed === uniqueUrls.length) {
        logger.info({ completed, total: uniqueUrls.length }, `Progress: ${completed}/${uniqueUrls.length}`);
      }

      // Add small delay to avoid overwhelming servers
      await sleep(100);

      return health;
    })
  );

  await Promise.all(checkPromises);

  // 3.5. Find replacement links for broken links (if enabled)
  const brokenHealthChecks = Array.from(healthChecks.entries()).filter(
    ([_, health]) => health.status === 'broken'
  );

  if (config.replacementSearch && brokenHealthChecks.length > 0) {
    logger.info(
      { brokenCount: brokenHealthChecks.length },
      `🔍 Searching for ${brokenHealthChecks.length} replacement links...`
    );

    let replacementsFound = 0;

    for (const [url, health] of brokenHealthChecks) {
      // Get link info from first occurrence
      const lessonOccurrences = urlToLessons.get(url);
      if (!lessonOccurrences || lessonOccurrences.length === 0) continue;

      const firstOccurrence = lessonOccurrences[0];
      const linkTitle = firstOccurrence.linkInfo.title;

      // Get lesson context for better search
      const lesson = allLessons.find((l) => l.metadata.id === firstOccurrence.lessonId);
      const lessonContext = lesson ? lesson.metadata.title : undefined;

      // Search for replacement
      const replacement = await findReplacementLink(url, linkTitle, lessonContext);

      if (replacement) {
        health.suggestedReplacement = replacement;
        replacementsFound++;
        logger.debug({ url, replacement: replacement.url }, 'Found replacement link');
      }

      // Add delay to avoid rate limiting
      await sleep(500);
    }

    logger.info({ replacementsFound }, `✅ Found ${replacementsFound} replacement suggestions`);
  }

  // 4. Build report grouped by lesson/chapter
  const lessonReports: LessonLinkReport[] = allLessons
    .filter((l) => l.content.links.length > 0)
    .map((l) => ({
      lessonId: l.metadata.id,
      lessonTitle: l.metadata.title,
      lessonUrl: l.metadata.url,
      chapterNumber: l.chapter.number,
      chapterTitle: l.chapter.title,
      links: l.content.links.map((link) => ({
        title: link.title,
        url: link.url,
        health: healthChecks.get(link.url)!,
      })),
    }))
    .sort((a, b) => a.chapterNumber - b.chapterNumber);

  // 5. Statistics
  const stats = Array.from(healthChecks.values());

  return {
    checkedAt: new Date(),
    totalLinks: stats.length,
    brokenLinks: stats.filter((h) => h.status === 'broken').length,
    movedLinks: stats.filter((h) => h.status === 'moved').length,
    timeoutLinks: stats.filter((h) => h.status === 'timeout').length,
    restrictedLinks: 0, // No longer tracked - anti-bot links are now counted as "ok"
    lessonReports,
  };
}

/**
 * Generate markdown report for human consumption
 */
function generateMarkdownReport(report: BrokenLinksReport, courseTitle: string): string {
  const { checkedAt, totalLinks, brokenLinks, movedLinks, timeoutLinks, restrictedLinks } = report;
  const okLinks = totalLinks - brokenLinks - movedLinks - timeoutLinks;

  let md = `# Broken Links Report - ${courseTitle}\n\n`;
  md += `**Generated:** ${checkedAt.toISOString()}\n`;
  md += `**Total Links Checked:** ${totalLinks}\n`;
  md += `**Broken Links (404/410 only):** ${brokenLinks} (${((brokenLinks / totalLinks) * 100).toFixed(1)}%)\n`;
  md += `**Moved Links:** ${movedLinks} (${((movedLinks / totalLinks) * 100).toFixed(1)}%)\n`;
  md += `**Timeout Links:** ${timeoutLinks} (${((timeoutLinks / totalLinks) * 100).toFixed(1)}%)\n\n`;

  md += `---\n\n## Summary\n\n`;
  md += `- ✅ **OK:** ${okLinks} links (${((okLinks / totalLinks) * 100).toFixed(1)}%)\n`;
  md += `  - Note: Includes links with anti-bot protection (403), method restrictions (405), or temporary issues (503)\n`;
  md += `- ❌ **Broken:** ${brokenLinks} links (${((brokenLinks / totalLinks) * 100).toFixed(1)}%) - Real 404/410 errors requiring attention\n`;
  md += `- 🔄 **Moved:** ${movedLinks} links (${((movedLinks / totalLinks) * 100).toFixed(1)}%) - Consider updating to final destination\n`;
  md += `- ⏱️ **Timeout:** ${timeoutLinks} links (${((timeoutLinks / totalLinks) * 100).toFixed(1)}%) - Server unreachable\n\n`;

  md += `---\n\n`;

  // Group by chapter
  const chapters = new Map<number, LessonLinkReport[]>();
  for (const lessonReport of report.lessonReports) {
    if (!chapters.has(lessonReport.chapterNumber)) {
      chapters.set(lessonReport.chapterNumber, []);
    }
    chapters.get(lessonReport.chapterNumber)!.push(lessonReport);
  }

  for (const [chapterNum, lessons] of Array.from(chapters.entries()).sort((a, b) => a[0] - b[0])) {
    const chapterTitle = lessons[0].chapterTitle;
    md += `## Chapter ${chapterNum}: ${chapterTitle}\n\n`;

    for (const lesson of lessons) {
      md += `### Lesson ${lesson.lessonId}: [${lesson.lessonTitle}](${lesson.lessonUrl})\n\n`;

      if (lesson.links.length === 0) {
        md += `No links found in this lesson.\n\n`;
        continue;
      }

      const okInLesson = lesson.links.filter((l) => l.health.status === 'ok');
      const brokenInLesson = lesson.links.filter((l) => l.health.status === 'broken');
      const movedInLesson = lesson.links.filter((l) => l.health.status === 'moved');
      const timeoutInLesson = lesson.links.filter((l) => l.health.status === 'timeout');

      // Show OK links first
      if (okInLesson.length > 0) {
        md += `#### ✅ OK Links (${okInLesson.length})\n`;
        for (const link of okInLesson) {
          md += `- **[${link.title}](${link.url})**\n`;
          md += `  - Status: ${link.health.statusCode} OK (${link.health.responseTime}ms)\n`;
          // Show note for special conditions (anti-bot, method restrictions, etc.)
          if (link.health.note) {
            md += `  - Note: ${link.health.note}\n`;
          }
        }
        md += `\n`;
      }

      // Show issues
      if (brokenInLesson.length > 0) {
        md += `#### ❌ Broken Links (${brokenInLesson.length})\n`;
        for (const link of brokenInLesson) {
          md += `- **[${link.title}](${link.url})**\n`;
          md += `  - Status: ${link.health.statusCode || 'Unknown'} ${link.health.error || ''}\n`;

          // Add suggested replacement if available
          if (link.health.suggestedReplacement) {
            const replacement = link.health.suggestedReplacement;
            md += `  - 💡 **Suggested Replacement:** [${replacement.title}](${replacement.url})`;
            if (replacement.relevanceScore) {
              md += ` (relevance: ${(replacement.relevanceScore * 100).toFixed(0)}%)`;
            }
            md += `\n`;
          }
        }
        md += `\n`;
      }

      if (movedInLesson.length > 0) {
        md += `#### 🔄 Moved Links (${movedInLesson.length})\n`;
        for (const link of movedInLesson) {
          md += `- **[${link.title}](${link.url})**\n`;
          md += `  - Status: ${link.health.statusCode} Moved\n`;
          md += `  - Redirected to: ${link.health.redirectedTo}\n`;
          md += `  - Suggestion: Update link to final destination\n`;
        }
        md += `\n`;
      }

      if (timeoutInLesson.length > 0) {
        md += `#### ⏱️ Timeout Links (${timeoutInLesson.length})\n`;
        for (const link of timeoutInLesson) {
          md += `- **[${link.title}](${link.url})**\n`;
          md += `  - Status: Timeout (${link.health.responseTime}ms)\n`;
          md += `  - Suggestion: Verify server availability or remove link\n`;
        }
        md += `\n`;
      }
    }
  }

  return md;
}

/**
 * Generate JSON export for Phase 2 (AI-powered fixer)
 * Flattens broken links with lesson context for easy updates
 */
function generateJSONReport(report: BrokenLinksReport, courseSlug: string): BrokenLinksJSON {
  const links: BrokenLinksJSON['links'] = [];

  for (const lessonReport of report.lessonReports) {
    for (const link of lessonReport.links) {
      // Only include problematic links (broken, moved, timeout)
      if (['broken', 'moved', 'timeout'].includes(link.health.status)) {
        links.push({
          url: link.url,
          title: link.title,
          status: link.health.status,
          statusCode: link.health.statusCode,
          lessonId: lessonReport.lessonId,
          lessonTitle: lessonReport.lessonTitle,
          chapterNumber: lessonReport.chapterNumber,
          chapterTitle: lessonReport.chapterTitle,
          lessonPath: `lessons/chapter-${lessonReport.chapterNumber}/lesson-${lessonReport.lessonId}.json`,
        });
      }
    }
  }

  return {
    generatedAt: report.checkedAt.toISOString(),
    courseSlug,
    totalLinks: report.totalLinks,
    brokenLinks: report.brokenLinks,
    movedLinks: report.movedLinks,
    restrictedLinks: report.restrictedLinks,
    timeoutLinks: report.timeoutLinks,
    links,
  };
}

/**
 * Load course structure from disk
 */
async function loadCourseStructure(courseSlug: string) {
  const structurePath = resolve(process.cwd(), 'output', courseSlug, 'course-structure.json');
  const data = await readFile(structurePath, 'utf-8');
  return JSON.parse(data);
}

/**
 * Main script orchestration
 */
async function main() {
  try {
    // 1. Load config
    const configPath = process.argv[2] || 'link-check-config.json';
    const config: LinkCheckConfig = JSON.parse(await readFile(configPath, 'utf-8'));

    logger.info('================================================================================');
    logger.info('🔍 LINK HEALTH CHECK');
    logger.info('================================================================================');
    logger.info({ courseSlug: config.courseSlug, concurrency: config.concurrency, timeout: config.timeout });
    logger.info('');

    // 2. Load course structure
    const structure = await loadCourseStructure(config.courseSlug);
    logger.info({ title: structure.title, slug: structure.slug }, '📚 Course structure loaded');
    logger.info('');

    // 3. Check all links
    const report = await checkAllLinks(config.courseSlug, {
      concurrency: config.concurrency,
      timeout: config.timeout,
      replacementSearch: config.replacementSearch.enabled,
    });

    // 4. Generate reports (markdown + JSON)
    const markdown = generateMarkdownReport(report, structure.title);
    const json = generateJSONReport(report, config.courseSlug);

    // 5. Save reports
    if (config.dryRun) {
      logger.info('📄 Dry-run mode - reports not saved');
      console.log(markdown);
    } else if (config.output.saveReport) {
      const baseDir = resolve('output', config.courseSlug);
      const mdPath = resolve(baseDir, config.output.reportPath);
      const jsonPath = resolve(baseDir, 'broken-links.json');

      await writeFile(mdPath, markdown, 'utf-8');
      await writeFile(jsonPath, JSON.stringify(json, null, 2), 'utf-8');

      logger.info({ mdPath, jsonPath }, '✅ Reports saved');
    }

    // 6. Summary
    logger.info('');
    logger.info('================================================================================');
    logger.info('✅ LINK CHECK COMPLETE');
    logger.info('================================================================================');
    logger.info(
      `📊 Total: ${report.totalLinks} | Broken (404/410): ${report.brokenLinks} | Moved: ${report.movedLinks} | Timeout: ${report.timeoutLinks}`
    );
    logger.info('');
  } catch (error: any) {
    logger.error({ error: error.message, stack: error.stack }, '❌ Link check failed');
    process.exit(1);
  }
}

main();
