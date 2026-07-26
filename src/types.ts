/**
 * Course structure extracted from index page
 */
export interface CourseStructure {
  title: string;
  slug: string; // URL-safe identifier (e.g., "my-course"), derived from the formation URL
  origin: string; // Scheme + host of the tenant domain (e.g., "https://formations.example.academy"), derived from the formation URL
  totalLessons: number;
  chapters: Chapter[];
  scrapedAt: Date;
}

export interface Chapter {
  number: number;
  title: string;
  lessons: LessonMetadata[];
}

export interface LessonMetadata {
  id: string;
  title: string;
  type: string; // emoji like 📚, ✍️, 🧠, etc.
  url: string;
  hasQuiz: boolean;
  quizQuestions: number;
  annexesCount: number;
}

/**
 * Content extracted from a lesson page
 */
export interface LessonContent {
  id: string;
  title: string;
  type: string;
  mainContent: string;
  rawHtml: string;
  links: Link[];
  extractedAt: Date;
}

export interface Link {
  title: string;
  url: string;
  target?: string; // '_blank' for external links
}

/**
 * Media content detected in lesson
 */
export interface MediaContent {
  type: 'youtube' | 'vimeo' | 'audio_mp3' | 'video_s3';
  mediaId?: string; // for YouTube/Vimeo
  url: string;
  downloaded: boolean;
  transcribed?: boolean; // Explicit flag for transcription status (for resume logic)
  localPath?: string;
  screenshots: string[]; // Story 6: thumbnail URLs or local paths (YouTube/Vimeo thumbnail, ffmpeg for S3)
  transcription?: string;
  transcriptionLanguage?: string;
  transcriptionConfidence?: number;
}

/**
 * Media processing statistics
 */
export interface MediaStats {
  totalMedia: number;
  downloaded: number;
  transcribed: number;
  totalMinutes: number;
  estimatedCost: number;
  errors: number;
  skipped: number;
  resumedSkipped: number; // Media skipped due to resume mode (already completed)
  byType: {
    youtube: number;
    vimeo: number;
    audio_mp3: number;
    video_s3: number;
  };
}

/**
 * AI content formatting statistics (Story 6.5)
 */
export interface FormattingStats {
  totalFormatted: number;           // Number of lessons formatted
  totalSummaries: number;            // Number of summaries generated
  totalOriginalChars: number;        // Total original content length
  totalFormattedChars: number;       // Total formatted content length
  totalSummaryChars: number;         // Total summary length
  avgReductionPercent: number;       // Average reduction % (calculated)
  errors: number;                    // Formatting errors
  totalKeywords: number;             // Total keywords generated across all lessons
  totalTechnologiesUsed: number;     // Total technologies used extracted
  totalTechnologiesMentioned: number; // Total technologies mentioned extracted
  avgKeywordsPerLesson: number;      // Average keywords per lesson (calculated)
  avgTechnologiesUsedPerLesson: number; // Average technologies used per lesson
  avgTechnologiesMentionedPerLesson: number; // Average technologies mentioned per lesson
}

/**
 * Proxy configuration for YouTube access via residential IP
 */
export interface ProxyConfig {
  enabled: boolean;
  url: string; // e.g., "http://127.0.0.1:9090"
}

/**
 * Anti-detection configuration for YouTube scraping
 * Implements best practices to avoid bot detection
 */
export interface AntiDetectionConfig {
  enableRandomJitter: boolean;        // Add ±40% random variation to delays
  exponentialBackoff: boolean;        // Use exponential backoff for retries (2^attempt)
  circuitBreakerThreshold: number;    // Stop after N consecutive YouTube errors (0 = disabled)
  cookiesFrom?: 'chrome' | 'firefox' | 'edge' | 'safari';  // Extract cookies from browser
  customHeaders?: {
    userAgent?: string;               // Custom User-Agent (default: yt-dlp's realistic UA)
    acceptLanguage?: string;          // Accept-Language header (e.g., 'fr-FR,fr;q=0.9')
    referer?: string;                 // Referer header (optional)
  };
}

/**
 * Qualified link with AI analysis
 */
export interface QualifiedLink {
  title: string;
  url: string;
  type: 'pdf' | 'web' | 'document';
  status: 'accessible' | '404' | 'error';
  qualified: boolean;
  summary?: string;
  keyPoints?: string[];
  contentType?: string;
  qualityScore?: number;
}

/**
 * Link health check result (Story 9)
 */
export interface LinkHealthCheck {
  url: string;
  status: 'ok' | 'broken' | 'moved' | 'timeout' | 'invalid';
  statusCode?: number;
  redirectedTo?: string;
  error?: string;
  note?: string; // For OK links with special conditions (anti-bot, auth, etc.)
  responseTime?: number; // in milliseconds
  checkedAt: Date;
  suggestedReplacement?: {
    url: string;
    title: string;
    relevanceScore?: number;
  };
}

/**
 * Link report for a single lesson (Story 9)
 */
export interface LessonLinkReport {
  lessonId: string;
  lessonTitle: string;
  lessonUrl: string;
  chapterNumber: number;
  chapterTitle: string;
  links: Array<{
    title: string;
    url: string;
    health: LinkHealthCheck;
  }>;
}

/**
 * Broken links report (Story 9)
 */
export interface BrokenLinksReport {
  checkedAt: Date;
  totalLinks: number;
  brokenLinks: number;
  movedLinks: number;
  timeoutLinks: number;
  restrictedLinks: number;
  lessonReports: LessonLinkReport[];
}

/**
 * Per-lesson formatting metrics (Story 6.5)
 */
export interface LessonFormattingMetrics {
  originalChars: number;            // fullContent length before formatting
  formattedChars: number;           // fullContentFormatted length after formatting
  summaryChars: number;             // summary length
  reductionPercent: number;         // (original - formatted) / original * 100
  keywordsCount: number;            // Number of keywords generated
  technologiesUsedCount: number;    // Number of technologies used
  technologiesMentionedCount: number; // Number of technologies mentioned
}

/**
 * Complete lesson data ready for markdown export
 */
export interface CompleteLesson {
  metadata: LessonMetadata;
  content: LessonContent;
  media: MediaContent[];          // Detected in Story 5, transcribed in Story 6
  fullContent?: string;            // Story 6 assembles: raw content + transcriptions (UNFORMATTED)
  fullContentFormatted?: string;   // Story 6.5 generates: cleaned/formatted version of fullContent
  summary?: string;                // Story 6.5 generates: concise lesson summary (2-4 sentences)
  keywords?: string[];             // Story 6.5 generates: general concepts/actions for Graph RAG indexing
  technologiesUsed?: string[];     // Story 6.5 generates: technologies actually used/practiced in the lesson
  technologiesMentioned?: string[]; // Story 6.5 generates: technologies mentioned as alternatives/comparisons
  formattingMetrics?: LessonFormattingMetrics; // Story 6.5 generates: per-lesson formatting statistics
  qualifiedLinks: QualifiedLink[]; // Story 7 populates this
  chapter: {
    number: number;
    title: string;
  };
  createdAt?: Date;                // Date de création de la leçon (source platform)
  lastUpdatedAt?: Date;            // Date de dernière mise à jour (source platform)
}

/**
 * Scraper progress checkpoint
 */
export interface ScraperProgress {
  lastProcessedLessonId: string;
  processedCount: number;
  totalCount: number;
  chapters: Record<
    string,
    {
      processed: number;
      total: number;
    }
  >;
  lastError: string | null;
  lastRun: Date;
}

/**
 * CLI configuration
 */
export interface ScraperConfig {
  email: string;
  password: string;
  openaiApiKey: string;
  jinaApiKey?: string;
  outputDir: string;
  concurrency: number;
  skipExisting: boolean;
  transcribe: boolean;
  downloadMedia: boolean;
  qualifyLinks: boolean;
  dryRun: boolean;
  timeout: number;
  retryAttempts: number;
  delayBetweenPages: number;
  formatting: {
    skipFormatting: boolean;
    model: 'gpt-4.1' | 'gpt-5'; // Default: gpt-4.1 (bon équilibre)
  };
}

/**
 * Technology usage tracking
 */
export interface TechnologyUsage {
  name: string;
  count: number; // Total occurrences across all lessons (used + mentioned)
  usedCount: number; // Number of lessons where technology is used (practiced)
  mentionedCount: number; // Number of lessons where technology is only mentioned
  firstAppearance: {
    chapterNumber: number;
    chapterTitle: string;
    lessonId: string;
    lessonTitle: string;
  };
  chapters: number[]; // Chapter numbers where this technology appears
  lessons: string[]; // Lesson IDs where this technology appears (used or mentioned)
  usedLessons: string[]; // Lesson IDs where this technology is used
  mentionedLessons: string[]; // Lesson IDs where this technology is mentioned
}

/**
 * Keyword usage tracking
 */
export interface KeywordUsage {
  keyword: string;
  count: number;
  chapters: number[];
  lessons: string[];
}

/**
 * Chapter summary for pedagogical graph
 */
export interface ChapterKnowledgeSummary {
  number: number;
  title: string;
  lessonCount: number;

  // Technologies
  newTechnologies: string[]; // First introduced in this chapter
  reusedTechnologies: string[]; // Already seen in previous chapters
  allTechnologies: string[]; // All technologies in this chapter
  usedTechnologies: string[]; // Technologies practiced in this chapter
  mentionedOnlyTechnologies: string[]; // Technologies only mentioned (not practiced)

  // Keywords
  keywords: string[];
  keywordCount: number;

  // Density metrics
  technologiesPerLesson: number;
  keywordsPerLesson: number;

  // Lessons detail
  lessons: Array<{
    id: string;
    title: string;
    type: string;
    technologies: string[];
    technologiesUsed: string[];
    technologiesMentioned: string[];
    keywords: string[];
  }>;
}

/**
 * Pedagogical knowledge graph
 */
export interface PedagogicalGraph {
  // Course metadata
  courseTitle: string;
  courseSlug: string;
  totalLessons: number;
  totalChapters: number;
  generatedAt: Date;

  // Global statistics
  statistics: {
    totalTechnologies: number;
    totalKeywords: number;
    avgTechnologiesPerLesson: number;
    avgKeywordsPerLesson: number;
    avgTechnologiesPerChapter: number;
    avgKeywordsPerChapter: number;
  };

  // Top technologies by frequency
  topTechnologies: TechnologyUsage[];

  // Top keywords by frequency
  topKeywords: KeywordUsage[];

  // Chapter-by-chapter progression
  chapters: ChapterKnowledgeSummary[];

  // Technology matrix (chapter × technology)
  technologyMatrix: {
    technologies: string[]; // Sorted by first appearance
    chapters: Array<{
      number: number;
      title: string;
      usage: number[]; // Count per technology (same order as technologies array)
    }>;
  };
}
