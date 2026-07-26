import fs from 'fs/promises';
import path from 'path';
import {
  CompleteLesson,
  CourseStructure,
  PedagogicalGraph,
  TechnologyUsage,
  KeywordUsage,
  ChapterKnowledgeSummary,
} from './types';

/**
 * Pedagogical analyzer - Generates knowledge graph from extracted lessons
 */

/**
 * Clean chapter title by removing common prefixes
 * Examples: "Module 1 - Title" -> "Title", "Chapitre 2: Title" -> "Title"
 */
function cleanChapterTitle(title: string): string {
  // Remove patterns like "Module 1 -", "Module 2 -", "Chapitre 1:", "Chapitre 2 :", etc.
  // Important: Remove emojis FIRST, then apply text pattern matching
  return title
    .replace(/^➡️\s*/, '') // Remove leading arrow emoji
    .replace(/^🔥\s*/, '') // Remove leading fire emoji
    .replace(/^Module\s+\d+\s*[-:]\s*/i, '')
    .replace(/^Chapitre\s+\d+\s*:?\s*/i, '')
    .trim();
}

/**
 * Load all lessons from the output directory
 */
import OpenAI from 'openai';
import { createLogger } from './utils.js';

const logger = createLogger('pedagogical-analyzer');

/**
 * Validation result from AI
 */
interface ValidationResult {
  validKeywords: string[];
  validTechnologies: string[];
  keywordCorrections: Record<string, string>;  // { "Rtable": "Airtable" }
  technologyCorrections: Record<string, string>;
  removedKeywords: string[];
  removedTechnologies: string[];
}

/**
 * Validate keywords and technologies using AI to filter out errors and irrelevant terms
 * This is a global validation done once before KG generation (Option 2)
 */
// Whitelist of critical technologies that should NEVER be filtered
const TECHNOLOGY_WHITELIST = new Set([
  'Airtable', 'Make', 'Webflow', 'Softr', 'Gmail', 'Notion', 'Figma', 'ChatGPT',
  'Google Sheets', 'Slack', 'Miro', 'OpenAI', 'Zapier', 'Excel', 'CRM',
  'Google Docs', 'Google Calendar', 'Bubble', 'Glide', 'Jotform', 'Claude',
  'GPT-4', 'GPT-5', 'n8n', 'Trello', 'Asana', 'Salesforce', 'JavaScript',
]);

async function validateKeywordsAndTechnologies(
  keywordMap: Map<string, KeywordUsage>,
  techMap: Map<string, TechnologyUsage>
): Promise<ValidationResult> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Prepare list of terms for AI
  const keywords = Array.from(keywordMap.keys());
  const technologies = Array.from(techMap.keys());

  logger.info(
    { keywordsCount: keywords.length, technologiesCount: technologies.length },
    '🔍 Validating keywords and technologies with AI (batch processing)...'
  );

  // Split into batches to avoid timeout
  const BATCH_SIZE = 100;
  const totalBatches = Math.ceil((keywords.length + technologies.length) / BATCH_SIZE);

  logger.info({ batchSize: BATCH_SIZE, totalBatches }, '📦 Processing in batches...');

  const aggregatedResult: ValidationResult = {
    validKeywords: [],
    validTechnologies: [],
    keywordCorrections: {},
    technologyCorrections: {},
    removedKeywords: [],
    removedTechnologies: [],
  };

  try {
    // Process keywords in batches
    const keywordBatches = [];
    for (let i = 0; i < keywords.length; i += BATCH_SIZE) {
      keywordBatches.push(keywords.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < keywordBatches.length; i++) {
      const batch = keywordBatches[i];
      logger.info({ batch: i + 1, total: keywordBatches.length, terms: batch.length }, '⏳ Processing keyword batch...');

      const prompt = `Tu es un expert en analyse pédagogique. Valide ces mots-clés extraits d'un cours.

**Mots-clés à valider** (${batch.length} termes):
${batch.join(', ')}

**Critères**:
- GARDER: Concepts pédagogiques clairs, compétences, méthodologies
- REJETER: Termes vagues, erreurs d'extraction
- CORRIGER: Variantes → version correcte

**Format JSON**:
{
  "validKeywords": ["terme1", "terme2"],
  "keywordCorrections": {"variante": "correct"},
  "removedKeywords": ["mauvais"]
}`;

      const response = await openai.chat.completions.create({
        model: 'gpt-5.1',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        reasoning_effort: 'low',
      } as any);

      const content = response.choices[0].message.content;
      if (content) {
        const result = JSON.parse(content);
        aggregatedResult.validKeywords.push(...(result.validKeywords || []));
        Object.assign(aggregatedResult.keywordCorrections, result.keywordCorrections || {});
        aggregatedResult.removedKeywords.push(...(result.removedKeywords || []));
      }
    }

    // Process technologies in batches
    const techBatches = [];
    for (let i = 0; i < technologies.length; i += BATCH_SIZE) {
      techBatches.push(technologies.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < techBatches.length; i++) {
      const batch = techBatches[i];
      logger.info({ batch: i + 1, total: techBatches.length, terms: batch.length }, '⏳ Processing technology batch...');

      const prompt = `Tu es un expert en analyse pédagogique. Valide ces technologies extraites d'un cours.

**Technologies à valider** (${batch.length} termes):
${batch.join(', ')}

**Critères**:
- GARDER: Outils concrets, logiciels, services, frameworks
- REJETER: Concepts génériques, erreurs
- CORRIGER: Erreurs/variantes → version correcte

**IMPORTANT**: Les technologies suivantes sont CRITIQUES et doivent être GARDÉES:
${Array.from(TECHNOLOGY_WHITELIST).filter(t => batch.includes(t)).join(', ')}

**Format JSON**:
{
  "validTechnologies": ["tech1", "tech2"],
  "technologyCorrections": {"variante": "correct"},
  "removedTechnologies": ["mauvais"]
}`;

      const response = await openai.chat.completions.create({
        model: 'gpt-5.1',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        reasoning_effort: 'low',
      } as any);

      const content = response.choices[0].message.content;
      if (content) {
        const result = JSON.parse(content);
        aggregatedResult.validTechnologies.push(...(result.validTechnologies || []));
        Object.assign(aggregatedResult.technologyCorrections, result.technologyCorrections || {});
        aggregatedResult.removedTechnologies.push(...(result.removedTechnologies || []));
      }
    }

    // Force-add whitelisted technologies that weren't validated
    const validTechSet = new Set(aggregatedResult.validTechnologies);
    for (const tech of technologies) {
      if (TECHNOLOGY_WHITELIST.has(tech) && !validTechSet.has(tech)) {
        logger.info({ tech }, '🔒 Force-adding whitelisted technology');
        aggregatedResult.validTechnologies.push(tech);
      }
    }

    logger.info(
      {
        validKeywords: aggregatedResult.validKeywords.length,
        validTechnologies: aggregatedResult.validTechnologies.length,
        keywordCorrections: Object.keys(aggregatedResult.keywordCorrections).length,
        technologyCorrections: Object.keys(aggregatedResult.technologyCorrections).length,
        removedKeywords: aggregatedResult.removedKeywords.length,
        removedTechnologies: aggregatedResult.removedTechnologies.length,
      },
      '✅ AI validation complete (all batches processed)'
    );

    // Log corrections
    if (Object.keys(aggregatedResult.keywordCorrections).length > 0) {
      const corrections = Object.entries(aggregatedResult.keywordCorrections).slice(0, 5);
      logger.info({ corrections }, `🔧 Keyword corrections (showing first 5 of ${Object.keys(aggregatedResult.keywordCorrections).length})`);
    }
    if (Object.keys(aggregatedResult.technologyCorrections).length > 0) {
      const corrections = Object.entries(aggregatedResult.technologyCorrections).slice(0, 5);
      logger.info({ corrections }, `🔧 Technology corrections (showing first 5 of ${Object.keys(aggregatedResult.technologyCorrections).length})`);
    }

    // Log removed items
    if (aggregatedResult.removedKeywords.length > 0) {
      logger.info({ removed: aggregatedResult.removedKeywords.slice(0, 10) }, `🗑️ Removed ${aggregatedResult.removedKeywords.length} invalid keywords (showing first 10)`);
    }
    if (aggregatedResult.removedTechnologies.length > 0) {
      logger.info({ removed: aggregatedResult.removedTechnologies.slice(0, 10) }, `🗑️ Removed ${aggregatedResult.removedTechnologies.length} invalid technologies (showing first 10)`);
    }

    return aggregatedResult;
  } catch (error: any) {
    logger.error({ error: error.message }, '❌ AI validation failed');
    // On error, return all terms as valid (fail-open strategy)
    logger.warn('⚠️ Falling back to unvalidated terms due to error');
    return {
      validKeywords: keywords,
      validTechnologies: technologies,
      keywordCorrections: {},
      technologyCorrections: {},
      removedKeywords: [],
      removedTechnologies: [],
    };
  }
}

async function loadAllLessons(
  outputDir: string,
  courseSlug: string
): Promise<CompleteLesson[]> {
  const lessonsDir = path.join(outputDir, courseSlug, 'lessons');
  const lessons: CompleteLesson[] = [];

  try {
    const chapterDirs = await fs.readdir(lessonsDir);

    for (const chapterDir of chapterDirs) {
      const chapterPath = path.join(lessonsDir, chapterDir);
      const stat = await fs.stat(chapterPath);

      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(chapterPath);
      const jsonFiles = files.filter((f) => f.endsWith('.json') && f.startsWith('lesson-'));

      for (const file of jsonFiles) {
        const filePath = path.join(chapterPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const lesson: CompleteLesson = JSON.parse(content);
        lessons.push(lesson);
      }
    }

    return lessons;
  } catch (error) {
    throw new Error(`Failed to load lessons: ${error}`);
  }
}

/**
 * Load course structure
 */
async function loadCourseStructure(
  outputDir: string,
  courseSlug: string
): Promise<CourseStructure> {
  const structurePath = path.join(outputDir, courseSlug, 'course-structure.json');
  const content = await fs.readFile(structurePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Deduplicate and count technologies (separate used vs mentioned)
 */
function deduplicateTechnologies(lessons: CompleteLesson[]): Map<string, TechnologyUsage> {
  const techMap = new Map<string, TechnologyUsage>();

  for (const lesson of lessons) {
    const usedTechs = lesson.technologiesUsed || [];
    const mentionedTechs = lesson.technologiesMentioned || [];

    // Combine for full list
    const allTechs = [...usedTechs, ...mentionedTechs];
    const uniqueTechs = [...new Set(allTechs)];

    for (const tech of uniqueTechs) {
      const isUsed = usedTechs.includes(tech);
      const isMentioned = mentionedTechs.includes(tech);

      if (!techMap.has(tech)) {
        techMap.set(tech, {
          name: tech,
          count: 0,
          usedCount: 0,
          mentionedCount: 0,
          firstAppearance: {
            chapterNumber: lesson.chapter.number,
            chapterTitle: cleanChapterTitle(lesson.chapter.title),
            lessonId: lesson.metadata.id,
            lessonTitle: lesson.metadata.title,
          },
          chapters: [],
          lessons: [],
          usedLessons: [],
          mentionedLessons: [],
        });
      }

      const usage = techMap.get(tech)!;
      usage.count += 1;
      usage.lessons.push(lesson.metadata.id);

      // Track used vs mentioned separately
      if (isUsed) {
        usage.usedCount += 1;
        usage.usedLessons.push(lesson.metadata.id);
      }
      if (isMentioned) {
        usage.mentionedCount += 1;
        usage.mentionedLessons.push(lesson.metadata.id);
      }

      if (!usage.chapters.includes(lesson.chapter.number)) {
        usage.chapters.push(lesson.chapter.number);
      }
    }
  }

  return techMap;
}

/**
 * Deduplicate and count keywords
 */
function deduplicateKeywords(lessons: CompleteLesson[]): Map<string, KeywordUsage> {
  const keywordMap = new Map<string, KeywordUsage>();

  for (const lesson of lessons) {
    const keywords = lesson.keywords || [];

    for (const keyword of keywords) {
      if (!keywordMap.has(keyword)) {
        keywordMap.set(keyword, {
          keyword,
          count: 0,
          chapters: [],
          lessons: [],
        });
      }

      const usage = keywordMap.get(keyword)!;
      usage.count += 1;
      usage.lessons.push(lesson.metadata.id);

      if (!usage.chapters.includes(lesson.chapter.number)) {
        usage.chapters.push(lesson.chapter.number);
      }
    }
  }

  return keywordMap;
}

/**
 * Build chapter-by-chapter knowledge summary
 */
function buildChapterSummaries(
  lessons: CompleteLesson[],
  techMap: Map<string, TechnologyUsage>
): ChapterKnowledgeSummary[] {
  // Group lessons by chapter
  const chapterLessons = new Map<number, CompleteLesson[]>();

  for (const lesson of lessons) {
    const chapterNum = lesson.chapter.number;
    if (!chapterLessons.has(chapterNum)) {
      chapterLessons.set(chapterNum, []);
    }
    chapterLessons.get(chapterNum)!.push(lesson);
  }

  // Build summaries for each chapter
  const summaries: ChapterKnowledgeSummary[] = [];
  const seenTechnologies = new Set<string>();

  // Sort chapters by number
  const sortedChapters = Array.from(chapterLessons.keys()).sort((a, b) => a - b);

  for (const chapterNum of sortedChapters) {
    const chapterLessonsArray = chapterLessons.get(chapterNum)!;
    const rawTitle = chapterLessonsArray[0]?.chapter.title || `Chapter ${chapterNum}`;
    const chapterTitle = cleanChapterTitle(rawTitle);

    // Collect all technologies in this chapter
    const chapterTechs = new Set<string>();
    const chapterUsedTechs = new Set<string>();
    const chapterMentionedTechs = new Set<string>();
    const chapterKeywords = new Set<string>();

    const lessonDetails = chapterLessonsArray.map((lesson) => {
      const usedTechs = lesson.technologiesUsed || [];
      const mentionedTechs = lesson.technologiesMentioned || [];
      const allTechs = [...usedTechs, ...mentionedTechs];
      const uniqueLessonTechs = [...new Set(allTechs)];

      uniqueLessonTechs.forEach((t) => chapterTechs.add(t));
      usedTechs.forEach((t) => chapterUsedTechs.add(t));
      mentionedTechs.forEach((t) => chapterMentionedTechs.add(t));
      (lesson.keywords || []).forEach((k) => chapterKeywords.add(k));

      return {
        id: lesson.metadata.id,
        title: lesson.metadata.title,
        type: lesson.metadata.type,
        technologies: uniqueLessonTechs,
        technologiesUsed: usedTechs,
        technologiesMentioned: mentionedTechs,
        keywords: lesson.keywords || [],
      };
    });

    // Determine new vs. reused technologies
    const newTechnologies: string[] = [];
    const reusedTechnologies: string[] = [];

    for (const tech of chapterTechs) {
      if (seenTechnologies.has(tech)) {
        reusedTechnologies.push(tech);
      } else {
        newTechnologies.push(tech);
        seenTechnologies.add(tech);
      }
    }

    const allTechnologies = Array.from(chapterTechs);
    const usedTechnologies = Array.from(chapterUsedTechs);
    // Mentioned only = mentioned but not used
    const mentionedOnlyTechnologies = Array.from(chapterMentionedTechs).filter(
      (t) => !chapterUsedTechs.has(t)
    );
    const keywords = Array.from(chapterKeywords);

    summaries.push({
      number: chapterNum,
      title: chapterTitle,
      lessonCount: chapterLessonsArray.length,
      newTechnologies,
      reusedTechnologies,
      allTechnologies,
      usedTechnologies,
      mentionedOnlyTechnologies,
      keywords,
      keywordCount: keywords.length,
      technologiesPerLesson:
        chapterLessonsArray.length > 0 ? allTechnologies.length / chapterLessonsArray.length : 0,
      keywordsPerLesson:
        chapterLessonsArray.length > 0 ? keywords.length / chapterLessonsArray.length : 0,
      lessons: lessonDetails,
    });
  }

  return summaries;
}

/**
 * Build technology matrix (chapter × technology)
 */
function buildTechnologyMatrix(
  lessons: CompleteLesson[],
  techMap: Map<string, TechnologyUsage>,
  chapterSummaries: ChapterKnowledgeSummary[]
): PedagogicalGraph['technologyMatrix'] {
  // Sort technologies by first appearance (chapter, then lesson)
  const sortedTechs = Array.from(techMap.values()).sort((a, b) => {
    if (a.firstAppearance.chapterNumber !== b.firstAppearance.chapterNumber) {
      return a.firstAppearance.chapterNumber - b.firstAppearance.chapterNumber;
    }
    return a.firstAppearance.lessonId.localeCompare(b.firstAppearance.lessonId);
  });

  const technologies = sortedTechs.map((t) => t.name);

  // Build chapter usage matrix
  const chapters = chapterSummaries.map((chapter) => {
    const usage = technologies.map((tech) => {
      // Count lessons in this chapter that use this technology
      return chapter.lessons.filter((lesson) => lesson.technologies.includes(tech)).length;
    });

    return {
      number: chapter.number,
      title: chapter.title,
      usage,
    };
  });

  return {
    technologies,
    chapters,
  };
}

/**
 * Main function: Generate pedagogical knowledge graph
 */
export async function generateKnowledgeGraph(
  outputDir: string,
  courseSlug: string,
  options?: { chapters?: number[] }
): Promise<PedagogicalGraph> {
  // Load data
  const courseStructure = await loadCourseStructure(outputDir, courseSlug);
  let lessons = await loadAllLessons(outputDir, courseSlug);

  if (lessons.length === 0) {
    throw new Error('No lessons found. Please run extraction first.');
  }

  // Filter by chapters if specified
  if (options?.chapters && options.chapters.length > 0) {
    const chaptersSet = new Set(options.chapters);
    lessons = lessons.filter((lesson) => chaptersSet.has(lesson.chapter.number));
    logger.info(
      { requestedChapters: options.chapters, filteredLessons: lessons.length },
      `📚 Filtered to ${options.chapters.length} chapters`
    );
  }

  if (lessons.length === 0) {
    throw new Error('No lessons found for the specified chapters.');
  }

  // Deduplicate and analyze (initial pass)
  const techMap = deduplicateTechnologies(lessons);
  const keywordMap = deduplicateKeywords(lessons);

  // ===== AI VALIDATION (Option 2: Global validation before KG generation) =====
  logger.info(
    {
      keywordsBeforeValidation: keywordMap.size,
      technologiesBeforeValidation: techMap.size,
    },
    '📊 Terms before validation'
  );

  // Call AI validation with batch processing - returns corrections mapping
  const validation = await validateKeywordsAndTechnologies(keywordMap, techMap);

  // Filter to keep only validated terms
  const validKeywordsSet = new Set(validation.validKeywords);
  const validTechnologiesSet = new Set(validation.validTechnologies);

  // Apply corrections AND filter to valid terms in all lessons
  logger.info('🔧 Applying corrections and filtering lessons...');
  for (const lesson of lessons) {
    // Correct AND filter keywords
    if (lesson.keywords) {
      lesson.keywords = lesson.keywords
        .map((kw) => validation.keywordCorrections[kw] || kw)
        .filter((kw) => validKeywordsSet.has(kw));
    }

    // Correct AND filter technologies used
    if (lesson.technologiesUsed) {
      lesson.technologiesUsed = lesson.technologiesUsed
        .map((tech) => validation.technologyCorrections[tech] || tech)
        .filter((tech) => validTechnologiesSet.has(tech));
    }

    // Correct AND filter technologies mentioned
    if (lesson.technologiesMentioned) {
      lesson.technologiesMentioned = lesson.technologiesMentioned
        .map((tech) => validation.technologyCorrections[tech] || tech)
        .filter((tech) => validTechnologiesSet.has(tech));
    }
  }

  // Re-deduplicate with corrected and filtered data
  logger.info('📊 Re-deduplicating with corrected and filtered terms...');
  const correctedTechMap = deduplicateTechnologies(lessons);
  const correctedKeywordMap = deduplicateKeywords(lessons);

  const filteredKeywordMap = new Map<string, KeywordUsage>();
  for (const [keyword, usage] of correctedKeywordMap.entries()) {
    if (validKeywordsSet.has(keyword)) {
      filteredKeywordMap.set(keyword, usage);
    }
  }

  const filteredTechMap = new Map<string, TechnologyUsage>();
  for (const [tech, usage] of correctedTechMap.entries()) {
    if (validTechnologiesSet.has(tech)) {
      filteredTechMap.set(tech, usage);
    }
  }

  logger.info(
    {
      keywordsAfterValidation: filteredKeywordMap.size,
      technologiesAfterValidation: filteredTechMap.size,
      keywordsRemoved: keywordMap.size - filteredKeywordMap.size,
      technologiesRemoved: techMap.size - filteredTechMap.size,
    },
    '✅ Validation complete - using corrected and filtered terms'
  );
  // ===== END AI VALIDATION =====

  // Build chapter summaries (with filtered maps)
  const chapterSummaries = buildChapterSummaries(lessons, filteredTechMap);

  // Build technology matrix (with filtered maps)
  const technologyMatrix = buildTechnologyMatrix(lessons, filteredTechMap, chapterSummaries);

  // Sort top technologies by count (descending)
  const topTechnologies = Array.from(filteredTechMap.values()).sort((a, b) => b.count - a.count);

  // Sort top keywords by count (descending)
  const topKeywords = Array.from(filteredKeywordMap.values()).sort((a, b) => b.count - a.count);

  // Calculate global statistics
  const totalTechnologies = filteredTechMap.size;
  const totalKeywords = filteredKeywordMap.size;

  const totalLessonTechCount = lessons.reduce((sum, lesson) => {
    const techs = new Set([
      ...(lesson.technologiesUsed || []),
      ...(lesson.technologiesMentioned || []),
    ]);
    return sum + techs.size;
  }, 0);

  const totalLessonKeywordCount = lessons.reduce((sum, lesson) => {
    return sum + (lesson.keywords || []).length;
  }, 0);

  const avgTechnologiesPerLesson =
    lessons.length > 0 ? totalLessonTechCount / lessons.length : 0;
  const avgKeywordsPerLesson = lessons.length > 0 ? totalLessonKeywordCount / lessons.length : 0;
  const avgTechnologiesPerChapter =
    chapterSummaries.length > 0 ? totalTechnologies / chapterSummaries.length : 0;
  const avgKeywordsPerChapter =
    chapterSummaries.length > 0 ? totalKeywords / chapterSummaries.length : 0;

  return {
    courseTitle: courseStructure.title,
    courseSlug: courseStructure.slug,
    totalLessons: lessons.length,
    totalChapters: chapterSummaries.length,
    generatedAt: new Date(),
    statistics: {
      totalTechnologies,
      totalKeywords,
      avgTechnologiesPerLesson,
      avgKeywordsPerLesson,
      avgTechnologiesPerChapter,
      avgKeywordsPerChapter,
    },
    topTechnologies,
    topKeywords,
    chapters: chapterSummaries,
    technologyMatrix,
  };
}
