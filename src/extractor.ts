/**
 * Story 5: Content Extraction - Per Lesson
 *
 * Extracts text content, media, and external links from lesson pages.
 * Converts HTML to Markdown for optimal Graph RAG / Neo4j chunking.
 *
 * ARCHITECTURE NOTES:
 * - Uses evaluate() to run extraction logic in browser context
 * - Media detected in Story 5, downloaded/transcribed in Story 6
 * - fullContent assembled in Story 6 (mainContent + transcriptions)
 * - qualifiedLinks populated in Story 7 (AI analysis)
 */

import type { Browser } from './browser.js';
import type { CourseStructure, LessonContent, CompleteLesson, MediaContent, Chapter, LessonMetadata } from './types.js';
import type { ExtractionConfig } from './config.js';
import { createLogger, sleep } from './utils.js';
import { TIMEOUTS, LESSON_EMOJIS } from './constants.js';
import { sanitizeUrl, sanitizeMarkdownText, validateExtractedContent } from './sanitizer.js';

const logger = createLogger('extractor');

// Configuration
const DEFAULT_DELAY_MS = 2000;

/**
 * Check if a lesson is a quiz/QCM
 * Detects quizzes by emoji type OR by title containing "quiz" or "qcm"
 */
function isQuiz(lesson: LessonMetadata): boolean {
  const lowerTitle = lesson.title.toLowerCase();
  return lesson.type === LESSON_EMOJIS.QUIZ || lowerTitle.includes('quiz') || lowerTitle.includes('qcm');
}

/**
 * Find a lesson in the course structure and return both lesson metadata and chapter context
 *
 * @param lessonId Lesson ID to find
 * @param courseStructure Complete course structure
 * @returns Lesson metadata and chapter context
 * @throws Error if lesson not found
 */
function findLessonInStructure(
  lessonId: string,
  courseStructure: CourseStructure
): { lesson: LessonMetadata; chapter: Chapter } {
  for (const chapter of courseStructure.chapters) {
    const lesson = chapter.lessons.find((l) => l.id === lessonId);
    if (lesson) {
      return { lesson, chapter };
    }
  }
  throw new Error(`Lesson ${lessonId} not found in course structure`);
}

/**
 * Extract content from a single lesson page
 *
 * @param lessonId Lesson ID to extract
 * @param browser Authenticated browser with active session
 * @param courseStructure Course structure (for lesson metadata lookup)
 * @returns Complete lesson with content, media, and metadata
 */
export async function extractLessonContent(
  lessonId: string,
  browser: Browser,
  courseStructure: CourseStructure
): Promise<CompleteLesson> {
  logger.info({ lessonId }, '📄 Extracting lesson content');

  // 1. Find lesson metadata and chapter context
  const { lesson: metadata, chapter } = findLessonInStructure(lessonId, courseStructure);

  // 2. Check if this is a quiz lesson (skip in Story 5)
  if (metadata.type === LESSON_EMOJIS.QUIZ) {
    logger.info({ lessonId, title: metadata.title }, '⏭️ Skipping quiz lesson (Story 5.1)');
    throw new Error(`Quiz lesson ${lessonId} not supported in Story 5 (see Story 5.1)`);
  }

  // 3. Check if this is from an ANC chapter (skip)
  if (chapter.title.includes('ANC')) {
    logger.info({ lessonId, chapterTitle: chapter.title }, '⏭️ Skipping ANC chapter lesson');
    throw new Error(`ANC chapter lessons not supported: ${chapter.title}`);
  }

  // 4. Navigate to lesson page
  const url = `${courseStructure.origin}/mon-espace/formations/${courseStructure.slug}/elements/${lessonId}`;
  logger.debug({ url }, 'Navigating to lesson');
  await browser.navigate(url);

  // 5. Wait for dynamic content to load
  logger.debug({ timeout: TIMEOUTS.PAGE_LOAD }, '⏳ Waiting for page load');
  await browser.waitFor({ timeout: TIMEOUTS.PAGE_LOAD });

  // 6. Extract content via evaluate() - runs in browser context
  logger.debug('📊 Extracting content from DOM');
  const extracted = await browser.evaluate(`
    (() => {
      // ============================================================================
      // Error Handling & Logging Helpers
      // ============================================================================

      const errors = [];
      const warnings = [];

      function logError(context, error) {
        errors.push({ context, error: error.message || String(error) });
      }

      function logWarning(context, message) {
        warnings.push({ context, message });
      }

      // ============================================================================
      // Security Sanitization (Browser-side)
      // ============================================================================

      /**
       * Sanitize URL to prevent XSS (browser-side version).
       * Strict allowlist: kept schemes are http(s)/mailto/tel; relative and
       * protocol-relative URLs pass; any other scheme is rejected.
       * Mirror of sanitizeUrl() in src/sanitizer.ts.
       */
      function sanitizeUrl(url) {
        if (!url || typeof url !== 'string') return '';

        const trimmed = url.trim();
        if (!trimmed) return '';

        // Protocol-relative and relative URLs are safe.
        if (trimmed.startsWith('//') || trimmed.startsWith('/')) return trimmed;

        const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
        if (schemeMatch) {
          const safeSchemes = ['http', 'https', 'mailto', 'tel'];
          if (safeSchemes.indexOf(schemeMatch[1].toLowerCase()) === -1) {
            logWarning('url-sanitization', 'Blocked URL with disallowed scheme: ' + trimmed);
            return '';
          }
          return trimmed;
        }

        // No scheme, not root-relative: treat as a relative path.
        return trimmed;
      }

      // ============================================================================
      // HTML to Markdown Conversion Helpers
      // ============================================================================

      /**
       * Process inline elements (bold, italic, links, br)
       */
      function processInlineElements(el) {
        let text = '';
        try {
          for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              const child = node;
              try {
                switch (child.tagName.toLowerCase()) {
                  case 'strong':
                  case 'b':
                    text += '**' + (child.textContent || '') + '**';
                    break;
                  case 'em':
                  case 'i':
                    text += '*' + (child.textContent || '') + '*';
                    break;
                  case 'a':
                    const href = child.getAttribute('href');
                    const sanitizedHref = sanitizeUrl(href);
                    if (sanitizedHref) {
                      text += '[' + (child.textContent || '') + '](' + sanitizedHref + ')';
                    } else {
                      // Keep text but remove dangerous link
                      text += child.textContent || '';
                    }
                    break;
                  case 'br':
                    text += '\\n';
                    break;
                  default:
                    // Recursively process nested elements
                    text += processInlineElements(child);
                }
              } catch (error) {
                logError('processInlineElements-child', error);
                // Continue with next node
              }
            }
          }
        } catch (error) {
          logError('processInlineElements', error);
        }
        return text;
      }

      /**
       * Process list elements (ul/ol)
       */
      function processList(el) {
        let markdown = '';
        try {
          const items = el.querySelectorAll('li');
          const isOrdered = el.tagName.toLowerCase() === 'ol';

          items.forEach((li, idx) => {
            try {
              const prefix = isOrdered ? (idx + 1) + '. ' : '- ';
              markdown += prefix + processInlineElements(li).trim() + '\\n';
            } catch (error) {
              logError('processList-item', error);
            }
          });
        } catch (error) {
          logError('processList', error);
        }

        return markdown;
      }

      /**
       * Convert HTML element to Markdown
       */
      function htmlToMarkdown(element) {
        let markdown = '';

        try {
          // Clone to avoid modifying original
          const clone = element.cloneNode(true);

          // Remove navigation, scripts, styles, buttons
          try {
            clone.querySelectorAll('nav, script, style, .navigation, button, .quiz-button').forEach(el => el.remove());
          } catch (error) {
            logError('htmlToMarkdown-cleanup', error);
          }

          // Process each child node
          for (const node of clone.childNodes) {
            try {
              if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent?.trim();
                if (text) {
                  markdown += text + '\\n';
                }
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                const el = node;

                switch (el.tagName.toLowerCase()) {
                  case 'h1':
                    // Ensure spacing before heading if content exists
                    if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                      markdown += '\\n\\n';
                    }
                    markdown += '# ' + (el.textContent?.trim() || '') + '\\n\\n';
                    break;
                  case 'h2':
                    if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                      markdown += '\\n\\n';
                    }
                    markdown += '## ' + (el.textContent?.trim() || '') + '\\n\\n';
                    break;
                  case 'h3':
                    if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                      markdown += '\\n\\n';
                    }
                    markdown += '### ' + (el.textContent?.trim() || '') + '\\n\\n';
                    break;
                  case 'h4':
                    if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                      markdown += '\\n\\n';
                    }
                    markdown += '#### ' + (el.textContent?.trim() || '') + '\\n\\n';
                    break;
                  case 'h5':
                    if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                      markdown += '\\n\\n';
                    }
                    markdown += '##### ' + (el.textContent?.trim() || '') + '\\n\\n';
                    break;
                  case 'h6':
                    if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                      markdown += '\\n\\n';
                    }
                    markdown += '###### ' + (el.textContent?.trim() || '') + '\\n\\n';
                    break;
                  case 'p':
                    const pContent = processInlineElements(el).trim();
                    if (pContent) {
                      markdown += pContent + '\\n\\n';
                    }
                    break;
                  case 'blockquote':
                    const quoteContent = processInlineElements(el).trim();
                    if (quoteContent) {
                      // Split multiline quotes and prefix each line with >
                      const quoteLines = quoteContent.split('\\n');
                      for (const line of quoteLines) {
                        if (line.trim()) {
                          markdown += '> ' + line.trim() + '\\n';
                        }
                      }
                      markdown += '\\n';
                    }
                    break;
                  case 'ul':
                  case 'ol':
                    const listContent = processList(el);
                    if (listContent.trim()) {
                      // Ensure spacing before list if content exists
                      if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                        markdown += '\\n';
                      }
                      markdown += listContent + '\\n';
                    }
                    break;
                  case 'hr':
                    if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                      markdown += '\\n\\n';
                    }
                    markdown += '---\\n\\n';
                    break;
                  case 'iframe':
                    try {
                      // Add placeholder for video iframes
                      const iframeSrc = sanitizeUrl(el.getAttribute('src') || '');
                      let mediaPlaceholder = '';

                      if (iframeSrc) {
                        // YouTube
                        const ytMatch = iframeSrc.match(/(?:youtube(?:-nocookie)?\\.com\\/embed\\/|youtu\\.be\\/)([^?&#]+)/);
                        if (ytMatch) {
                          mediaPlaceholder = '[MEDIA:youtube-' + ytMatch[1] + ']';
                        }

                        // Vimeo
                        const vimeoMatch = iframeSrc.match(/vimeo\\.com\\/video\\/(\\d+)/);
                        if (vimeoMatch) {
                          mediaPlaceholder = '[MEDIA:vimeo-' + vimeoMatch[1] + ']';
                        }

                        if (mediaPlaceholder) {
                          // Ensure spacing before media placeholder
                          if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                            markdown += '\\n';
                          }
                          markdown += mediaPlaceholder + '\\n\\n';
                        }
                      }
                    } catch (error) {
                      logError('htmlToMarkdown-iframe', error);
                    }
                    break;
                  case 'video':
                    try {
                      // Add placeholder for video elements
                      const videoSrc = sanitizeUrl(el.getAttribute('src') || '');
                      if (videoSrc) {
                        if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                          markdown += '\\n';
                        }
                        markdown += '[MEDIA:video-' + videoSrc + ']\\n\\n';
                      }
                    } catch (error) {
                      logError('htmlToMarkdown-video', error);
                    }
                    break;
                  case 'audio':
                    try {
                      // Add placeholder for audio elements
                      const audioSrc = sanitizeUrl(el.getAttribute('src') || '');
                      if (audioSrc) {
                        if (markdown.trim().length > 0 && !markdown.endsWith('\\n\\n')) {
                          markdown += '\\n';
                        }
                        markdown += '[MEDIA:audio-' + audioSrc + ']\\n\\n';
                      }
                    } catch (error) {
                      logError('htmlToMarkdown-audio', error);
                    }
                    break;
                  default:
                    // For other elements, recursively process if they have children
                    try {
                      if (el.children.length > 0) {
                        markdown += htmlToMarkdown(el);
                      }
                    } catch (error) {
                      logError('htmlToMarkdown-recursive', error);
                    }
                }
              }
            } catch (error) {
              logError('htmlToMarkdown-node', error);
            }
          }
        } catch (error) {
          logError('htmlToMarkdown-main', error);
        }

        return markdown.trim();
      }

      // ============================================================================
      // Content Extraction
      // ============================================================================

      // Extract title
      const h1 = document.querySelector('h1');
      const title = h1?.textContent?.trim() || '';

      // Extract emoji type
      const emojiMatch = title.match(/(📚|✍️|🧠|🔥|📔)/);
      const type = emojiMatch ? emojiMatch[0] : '';

      // ============================================================================
      // Find Content Container using Multi-Strategy Approach (C4 Fix)
      // ============================================================================

      let contentContainer = null;
      let detectionStrategy = 'none';

      try {
        // Strategy 1: Semantic HTML - Look for <main> or <article>
        const mainElement = document.querySelector('main, article');
        if (mainElement) {
          const paragraphCount = mainElement.querySelectorAll('p').length;
          // Validate: must have at least 2 paragraphs to be real content
          if (paragraphCount >= 2) {
            contentContainer = mainElement;
            detectionStrategy = 'semantic-html';
          }
        }

        // Strategy 2: Class-based detection (common CMS patterns)
        if (!contentContainer) {
          const selectors = [
            '.lesson-content',
            '.course-content',
            '[class*="content-wrapper"]',
            '[class*="lesson-body"]',
            '[class*="main-content"]',
          ];

          for (const selector of selectors) {
            try {
              const element = document.querySelector(selector);
              if (element) {
                const paragraphCount = element.querySelectorAll('p').length;
                if (paragraphCount >= 2) {
                  contentContainer = element;
                  detectionStrategy = 'class-based:' + selector;
                  break;
                }
              }
            } catch (error) {
              logError('container-detection-selector', error);
            }
          }
        }

        // Strategy 3: H1 proximity - Walk up from H1 to find content-rich parent
        if (!contentContainer && h1) {
          let parent = h1.parentElement;
          let bestCandidate = null;
          let bestScore = 0;
          const maxLevel = 6;

          for (let level = 0; level < maxLevel && parent; level++) {
            try {
              const paragraphCount = parent.querySelectorAll('p').length;
              const headingCount = parent.querySelectorAll('h2, h3, h4').length;
              const listCount = parent.querySelectorAll('ul, ol').length;

              // Scoring system: paragraphs are most important
              const score = (paragraphCount * 3) + headingCount + listCount;

              // Penalize if contains too many navigation elements
              const navCount = parent.querySelectorAll('nav, .navigation, header, footer').length;
              const adjustedScore = score - (navCount * 5);

              if (adjustedScore > bestScore && paragraphCount >= 2) {
                bestScore = adjustedScore;
                bestCandidate = parent;
              }
            } catch (error) {
              logError('container-detection-h1-walk', error);
            }

            parent = parent.parentElement;
          }

          if (bestCandidate) {
            contentContainer = bestCandidate;
            detectionStrategy = 'h1-proximity-score:' + bestScore;
          }
        }

        // Strategy 4: Paragraph density - Find container with highest p-to-size ratio
        if (!contentContainer) {
          const firstP = document.querySelector('p');
          if (firstP) {
            let parent = firstP.parentElement;
            let bestCandidate = null;
            let bestScore = 0;
            const maxLevel = 6;

            for (let level = 0; level < maxLevel && parent; level++) {
              try {
                const paragraphCount = parent.querySelectorAll('p').length;
                const totalElements = parent.querySelectorAll('*').length;

                // Density ratio: high paragraph count relative to total elements
                const density = totalElements > 0 ? paragraphCount / totalElements : 0;
                const score = density * paragraphCount;

                if (score > bestScore && paragraphCount >= 2) {
                  bestScore = score;
                  bestCandidate = parent;
                }
              } catch (error) {
                logError('container-detection-density', error);
              }

              parent = parent.parentElement;
            }

            if (bestCandidate) {
              contentContainer = bestCandidate;
              detectionStrategy = 'paragraph-density:' + bestScore.toFixed(2);
            }
          }
        }

        // Fallback: Use body if nothing else found (with warning)
        if (!contentContainer) {
          contentContainer = document.body;
          detectionStrategy = 'fallback-body';
          logWarning('container-detection', 'Using body as fallback - may extract unwanted content');
        }

      } catch (error) {
        logError('container-detection-main', error);
        contentContainer = document.body;
        detectionStrategy = 'error-fallback';
      }

      // Convert to Markdown
      const mainContent = contentContainer ? htmlToMarkdown(contentContainer) : '';

      // Get raw HTML
      const rawHtml = contentContainer?.innerHTML || '';

      // ============================================================================
      // Extract External Links (with XSS protection)
      // ============================================================================

      const links = [];
      try {
        const allLinks = Array.from(document.querySelectorAll('a[href]'));

        for (const a of allLinks) {
          try {
            const href = a.getAttribute('href') || '';
            const sanitizedHref = sanitizeUrl(href);

            if (!sanitizedHref) continue; // Skip dangerous URLs

            const isExternal = href.startsWith('http') || href.startsWith('//');
            const notYoutube = !href.includes('youtube.com') && !href.includes('youtube-nocookie.com') && !href.includes('youtu.be');
            const notVimeo = !href.includes('vimeo.com');
            const notInternal = !href.includes('/mon-espace') && !href.includes(location.host);

            if (isExternal && notYoutube && notVimeo && notInternal) {
              links.push({
                title: a.textContent?.trim() || '',
                url: sanitizedHref,
                target: a.getAttribute('target') || undefined
              });
            }
          } catch (error) {
            logError('extract-link', error);
          }
        }
      } catch (error) {
        logError('extract-links-main', error);
      }

      // ============================================================================
      // Extract Media (with XSS protection and error handling)
      // ============================================================================

      const media = [];

      try {
        // YouTube iframes (including youtube-nocookie.com)
        try {
          const youtubeIframes = Array.from(document.querySelectorAll('iframe[src*="youtube"], iframe[src*="youtu.be"]'));
          for (const iframe of youtubeIframes) {
            try {
              const src = sanitizeUrl(iframe.getAttribute('src') || '');
              if (!src) continue;

              // Match youtube.com, youtube-nocookie.com, youtu.be
              const match = src.match(/(?:youtube(?:-nocookie)?\\.com\\/embed\\/|youtu\\.be\\/)([^?&#]+)/);
              if (match) {
                media.push({
                  type: 'youtube',
                  mediaId: match[1],
                  url: src,
                  downloaded: false,
                  screenshots: []
                });
              }
            } catch (error) {
              logError('extract-youtube', error);
            }
          }
        } catch (error) {
          logError('extract-youtube-main', error);
        }

        // Vimeo iframes
        try {
          const vimeoIframes = Array.from(document.querySelectorAll('iframe[src*="vimeo.com/video"]'));
          for (const iframe of vimeoIframes) {
            try {
              const src = sanitizeUrl(iframe.getAttribute('src') || '');
              if (!src) continue;

              const match = src.match(/vimeo\\.com\\/video\\/(\\d+)/);
              if (match) {
                media.push({
                  type: 'vimeo',
                  mediaId: match[1],
                  url: src,
                  downloaded: false,
                  screenshots: []
                });
              }
            } catch (error) {
              logError('extract-vimeo', error);
            }
          }
        } catch (error) {
          logError('extract-vimeo-main', error);
        }

        // Audio elements
        try {
          const audios = Array.from(document.querySelectorAll('audio[src]'));
          for (const audio of audios) {
            try {
              const src = sanitizeUrl(audio.getAttribute('src') || '');
              if (src && !media.find(m => m.url === src)) {
                media.push({
                  type: 'audio_mp3',
                  url: src,
                  downloaded: false,
                  screenshots: []
                });
              }
            } catch (error) {
              logError('extract-audio', error);
            }
          }
        } catch (error) {
          logError('extract-audio-main', error);
        }

        // Video elements (S3 or other sources)
        try {
          const videos = Array.from(document.querySelectorAll('video[src]'));
          for (const video of videos) {
            try {
              const src = sanitizeUrl(video.getAttribute('src') || '');
              if (src && !media.find(m => m.url === src)) {
                media.push({
                  type: 'video_s3',
                  url: src,
                  downloaded: false,
                  screenshots: []
                });
              }
            } catch (error) {
              logError('extract-video', error);
            }
          }
        } catch (error) {
          logError('extract-video-main', error);
        }

        // Also check for video/audio elements with source children
        try {
          const videoElements = Array.from(document.querySelectorAll('video'));
          for (const video of videoElements) {
            try {
              const sources = video.querySelectorAll('source[src]');
              for (const source of sources) {
                try {
                  const src = sanitizeUrl(source.getAttribute('src') || '');
                  if (src && !media.find(m => m.url === src)) {
                    media.push({
                      type: 'video_s3',
                      url: src,
                      downloaded: false,
                      screenshots: []
                    });
                  }
                } catch (error) {
                  logError('extract-video-source', error);
                }
              }
            } catch (error) {
              logError('extract-video-sources', error);
            }
          }
        } catch (error) {
          logError('extract-video-elements', error);
        }

        try {
          const audioElements = Array.from(document.querySelectorAll('audio'));
          for (const audio of audioElements) {
            try {
              const sources = audio.querySelectorAll('source[src]');
              for (const source of sources) {
                try {
                  const src = sanitizeUrl(source.getAttribute('src') || '');
                  if (src && !media.find(m => m.url === src)) {
                    media.push({
                      type: 'audio_mp3',
                      url: src,
                      downloaded: false,
                      screenshots: []
                    });
                  }
                } catch (error) {
                  logError('extract-audio-source', error);
                }
              }
            } catch (error) {
              logError('extract-audio-sources', error);
            }
          }
        } catch (error) {
          logError('extract-audio-elements', error);
        }

      } catch (error) {
        logError('extract-media-main', error);
      }

      // ============================================================================
      // Return Results with Error/Warning Logs
      // ============================================================================

      return {
        title,
        type,
        mainContent,
        rawHtml,
        links,
        media,
        // Metadata for debugging and monitoring
        _meta: {
          detectionStrategy,
          errors,
          warnings
        }
      };
    })()
  `);

  // 7. Log extraction metadata (errors, warnings, detection strategy)
  if (extracted._meta) {
    logger.debug(
      {
        lessonId,
        detectionStrategy: extracted._meta.detectionStrategy,
        errorsCount: extracted._meta.errors.length,
        warningsCount: extracted._meta.warnings.length,
      },
      '🔍 Extraction metadata'
    );

    // Log errors if any
    if (extracted._meta.errors.length > 0) {
      logger.warn({ lessonId, errors: extracted._meta.errors }, '⚠️ Extraction errors detected');
    }

    // Log warnings if any
    if (extracted._meta.warnings.length > 0) {
      logger.debug({ lessonId, warnings: extracted._meta.warnings }, '⚡ Extraction warnings');
    }
  }

  // 8. Validate extracted content
  const validationErrors = validateExtractedContent({
    title: extracted.title,
    mainContent: extracted.mainContent,
    links: extracted.links,
    media: extracted.media,
  });

  if (validationErrors.length > 0) {
    logger.error(
      { lessonId, validationErrors },
      '❌ Content validation failed'
    );
    throw new Error(`Content validation failed: ${validationErrors.join(', ')}`);
  }

  // 9. Build LessonContent (text only, no media at this level)
  const content: LessonContent = {
    id: lessonId,
    title: extracted.title,
    type: extracted.type,
    mainContent: extracted.mainContent,
    rawHtml: extracted.rawHtml,
    links: extracted.links,
    extractedAt: new Date(),
  };

  // 8. Assemble CompleteLesson (media at top level)
  const completeLesson: CompleteLesson = {
    metadata,
    content,
    media: extracted.media, // Media at CompleteLesson level
    fullContent: undefined, // Story 6 will populate after transcription
    qualifiedLinks: [], // Story 7 will populate this
    chapter: {
      number: chapter.number,
      title: chapter.title,
    },
    createdAt: undefined, // TODO: Extract from the formation page (future work)
    lastUpdatedAt: undefined, // TODO: Extract from the formation page (future work)
  };

  logger.info(
    {
      lessonId,
      title: content.title,
      type: content.type,
      contentLength: content.mainContent.length,
      linksCount: content.links.length,
      mediaCount: completeLesson.media.length,
      chapterNumber: chapter.number,
    },
    '✅ Lesson extracted'
  );

  return completeLesson;
}

/**
 * Extract all lessons from a specific chapter
 *
 * @param chapterNumber Chapter number to extract (1-based)
 * @param browser Authenticated browser with active session
 * @param courseStructure Course structure
 * @returns Array of complete lessons
 */
export async function extractChapterLessons(
  chapterNumber: number,
  browser: Browser,
  courseStructure: CourseStructure,
  config: ExtractionConfig
): Promise<CompleteLesson[]> {
  const chapter = courseStructure.chapters.find((ch) => ch.number === chapterNumber);

  if (!chapter) {
    throw new Error(`Chapter ${chapterNumber} not found in course structure`);
  }

  // Skip "ANC" chapters
  if (chapter.title.includes('ANC')) {
    logger.warn({ chapterNumber, title: chapter.title }, '⏭️ Skipping ANC chapter');
    return [];
  }

  logger.info(
    { chapterNumber, title: chapter.title, lessonsCount: chapter.lessons.length },
    '📚 Extracting chapter lessons'
  );

  // We iterate over ALL lessons (including quizzes) to mark them as complete
  // but only extract non-quiz lessons
  const lessons = chapter.lessons;

  const results: CompleteLesson[] = [];

  for (const [index, lessonMeta] of lessons.entries()) {
    const lessonIdx = index + 1; // 1-based index

    // Skip quizzes if configured, but mark them as complete first
    if (config.filters?.skipQuizzes && isQuiz(lessonMeta)) {
      logger.info({ lessonId: lessonMeta.id, title: lessonMeta.title }, '⏭️ Skipping quiz (will be auto-completed)');

      // Auto-complete this quiz before skipping it
      if (config.lessonCompletion?.autoValidate) {
        const { autoCompleteQuiz } = await import('./quiz-validator.js');
        const quizUrl = `${config.formationUrl}/elements/${lessonMeta.id}`;
        logger.info({ lessonId: lessonMeta.id }, '🎯 Auto-completing skipped quiz...');
        const result = await autoCompleteQuiz(browser, quizUrl);

        if (result.success) {
          logger.info({ lessonId: lessonMeta.id, questionCount: result.questionCount }, '✅ Quiz auto-completed successfully');
        } else {
          logger.error({ lessonId: lessonMeta.id, error: result.error }, '❌ Failed to auto-complete quiz');
        }
      }

      // Rate limiting
      if (config.rateLimit?.enableRateLimit && index < lessons.length - 1) {
        await sleep(config.rateLimit.delayMs);
      }

      continue; // Skip extraction for this quiz
    }

    try {
      const completeLesson = await extractLessonContent(lessonMeta.id, browser, courseStructure);
      results.push(completeLesson);

      // Story 10: Mark lesson as complete after extraction if auto-validation is enabled
      if (config.lessonCompletion?.autoValidate) {
        const { markLessonComplete } = await import('./lesson-completion.js');
        const lessonUrl = `${config.formationUrl}/elements/${lessonMeta.id}`;
        logger.info({ lessonId: lessonMeta.id }, '🔘 Marking lesson as complete');
        await markLessonComplete(
          browser,
          lessonUrl,
          config.lessonCompletion?.waitAfterConfirm || 2000
        );
      }

      // Rate limiting (except for last lesson)
      if (config.rateLimit?.enableRateLimit && index < lessons.length - 1) {
        logger.debug({ delayMs: config.rateLimit.delayMs }, '⏳ Rate limiting delay');
        await sleep(config.rateLimit.delayMs);
      }
    } catch (error) {
      logger.error(
        { lessonId: lessonMeta.id, title: lessonMeta.title, error: error instanceof Error ? error.message : String(error) },
        '❌ Failed to extract lesson'
      );
      // Continue with next lesson (don't fail entire batch)
    }
  }

  logger.info(
    { chapterNumber, extracted: results.length, total: lessons.length },
    '✅ Chapter extraction complete'
  );

  return results;
}

/**
 * Extract all lessons of a specific type (by emoji)
 *
 * @param lessonType Lesson type emoji (📚, ✍️, 📔, 🔥)
 * @param browser Authenticated browser with active session
 * @param courseStructure Course structure
 * @returns Array of complete lessons
 */
export async function extractLessonsByType(
  lessonType: string,
  browser: Browser,
  courseStructure: CourseStructure,
  config: ExtractionConfig
): Promise<CompleteLesson[]> {
  logger.info({ lessonType }, '🔍 Extracting lessons by type');

  // Skip quiz type in Story 5
  if (lessonType === LESSON_EMOJIS.QUIZ) {
    logger.warn({ lessonType }, '⏭️ Quiz lessons not supported in Story 5 (see Story 5.1)');
    return [];
  }

  // Collect all lessons of this type (excluding ANC chapters if configured)
  const matchingLessons: Array<{ lesson: LessonMetadata; chapter: Chapter }> = [];

  for (const chapter of courseStructure.chapters) {
    // Skip ANC chapters if configured
    if (config.filters?.skipAncChapters && chapter.title.includes('ANC')) {
      continue;
    }

    for (const lesson of chapter.lessons) {
      // Skip quizzes if configured
      if (config.filters?.skipQuizzes && isQuiz(lesson)) {
        continue;
      }

      if (lesson.type === lessonType) {
        matchingLessons.push({ lesson, chapter });
      }
    }
  }

  logger.info({ lessonType, count: matchingLessons.length }, `Found ${matchingLessons.length} lessons`);

  const results: CompleteLesson[] = [];

  for (const [index, { lesson: lessonMeta }] of matchingLessons.entries()) {
    const lessonIdx = index + 1; // 1-based index

    try {
      const completeLesson = await extractLessonContent(lessonMeta.id, browser, courseStructure);
      results.push(completeLesson);

      // Story 10: Mark lesson as complete after extraction if auto-validation is enabled
      if (config.lessonCompletion?.autoValidate) {
        const { markLessonComplete } = await import('./lesson-completion.js');
        const lessonUrl = `${config.formationUrl}/elements/${lessonMeta.id}`;
        logger.info({ lessonId: lessonMeta.id }, '🔘 Marking lesson as complete');
        await markLessonComplete(
          browser,
          lessonUrl,
          config.lessonCompletion?.waitAfterConfirm || 2000
        );
      }

      // Rate limiting
      if (config.rateLimit?.enableRateLimit && index < matchingLessons.length - 1) {
        logger.debug({ delayMs: config.rateLimit.delayMs }, '⏳ Rate limiting delay');
        await sleep(config.rateLimit.delayMs);
      }
    } catch (error) {
      logger.error(
        { lessonId: lessonMeta.id, title: lessonMeta.title, error: error instanceof Error ? error.message : String(error) },
        '❌ Failed to extract lesson'
      );
      // Continue with next lesson
    }
  }

  logger.info(
    { lessonType, extracted: results.length, total: matchingLessons.length },
    '✅ Type-based extraction complete'
  );

  return results;
}
