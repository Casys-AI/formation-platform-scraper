import { ChatOpenAI } from '@langchain/openai';

import { createLogger } from './utils.js';
import type { CompleteLesson, FormattingStats } from './types.js';

const logger = createLogger('ContentFormatter');

/**
 * Create empty FormattingStats object
 */
export function createFormattingStats(): FormattingStats {
  return {
    totalFormatted: 0,
    totalSummaries: 0,
    totalOriginalChars: 0,
    totalFormattedChars: 0,
    totalSummaryChars: 0,
    avgReductionPercent: 0,
    errors: 0,
    totalKeywords: 0,
    totalTechnologiesUsed: 0,
    totalTechnologiesMentioned: 0,
    avgKeywordsPerLesson: 0,
    avgTechnologiesUsedPerLesson: 0,
    avgTechnologiesMentionedPerLesson: 0,
  };
}

/**
 * Modèles disponibles pour le formatting
 */
export type FormattingModel = 'gpt-4.1' | 'gpt-5';

/**
 * Formatting options
 */
export interface FormattingOptions {
  skipFormatting?: boolean; // Skip AI formatting entirely
  model?: FormattingModel; // AI model (default: gpt-4.1)
  stats?: FormattingStats;  // Optional stats object to track metrics
}

/**
 * Factory pour créer le bon modèle selon la config
 * Retourne ChatOpenAI configuré (compatible avec l'archi CASYS)
 */
function createFormattingModel(model: FormattingModel): ChatOpenAI {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  if (model === 'gpt-5') {
    // GPT-5 avec reasoning (premium, meilleur pour raisonnement complexe)
    // Source: packages/infrastructure/src/adapters/server/ai/openai.adapter.ts
    return new ChatOpenAI({
      apiKey,
      model: 'gpt-5',
      reasoning: {
        effort: 'low', // 'minimal' | 'low' | 'medium' | 'high'
      },
    });
  } else {
    // gpt-4.1 (modèle standard, bon équilibre qualité/coût)
    // NOTE: gpt-4.1 ne supporte PAS le param 'reasoning' (erreur API)
    return new ChatOpenAI({
      apiKey,
      model: 'gpt-4.1',
      temperature: 0.3, // Low temp for consistency
    });
  }
}

/**
 * Build prompt for content formatting + summarization
 */
function buildFormattingPrompt(fullContent: string, lessonTitle: string): string {
  return `Tu es un formateur de contenu éducatif pour un système de Graph RAG.

TÂCHE 1 - Formater le Contenu:
1. Nettoie les artefacts de transcription audio:
   - Supprime les mots de remplissage ("euh", "hum", "ben", "voilà", "donc euh")
   - Supprime les répétitions inutiles
   - Supprime les timestamps [00:12] ou similaires
2. Unifie le formatage markdown:
   - Hiérarchie cohérente: H1 pour titre, H2 pour sections, H3 pour sous-sections
   - Listes formatées proprement (bullet points, listes numérotées)
   - Espacement cohérent (pas de double saut de ligne inutile)
   - Liens bien formatés: [texte](url)
3. Optimise pour Graph RAG:
   - Découpe les longs paragraphes en chunks sémantiques (3-5 phrases max)
   - Ajoute des sauts de section clairs
   - Préserve tous les termes techniques importants
   - NE PAS résumer - garde tout le contenu factuel
4. Corrige la ponctuation et la structure des phrases issues de speech-to-text

TÂCHE 2 - Générer un Résumé:
1. Écris un résumé concis de 2-4 phrases
2. Capture les objectifs d'apprentissage clés et les sujets principaux
3. Inclus les termes techniques importants
4. Format: texte brut (pas de markdown)
5. Adapté pour aperçu de recherche et navigation

TÂCHE 3 - Extraire des Mots-Clés et Technologies:
1. Extrais 5-10 mots-clés généraux (concepts et actions):
   - Concepts clés (ex: "base de données", "modélisation", "relations")
   - Actions/compétences (ex: "schématisation", "structuration", "CRM")

2. Identifie séparément les technologies (outils logiciels):
   - Technologies UTILISÉES: outils démontrés, pratiqués, ou au cœur de la leçon (ex: "Airtable", "Lucidchart")
   - Technologies MENTIONNÉES: alternatives citées, comparaisons, références (ex: "Whimsical", "Miro", "Notion")

3. Format: tableaux de strings
4. Objectif: faciliter l'indexation Graph RAG et la recherche sémantique

IMPORTANT:
- Préserve l'exactitude factuelle (ne supprime PAS d'informations)
- Garde le titre original tel quel
- Retourne du JSON valide

---

Titre de la leçon: ${lessonTitle}

Contenu brut:
${fullContent}

Retourne un objet JSON avec:
{
  "formattedContent": "contenu nettoyé en markdown...",
  "summary": "résumé en 2-4 phrases...",
  "keywords": ["concept1", "action1", "concept2", ...],
  "technologiesUsed": ["Airtable", "Lucidchart", ...],
  "technologiesMentioned": ["Whimsical", "Miro", "Notion", ...]
}`;
}

/**
 * Format fullContent + generate summary using LangChain ChatOpenAI
 * @param lesson - CompleteLesson with fullContent (from Story 6)
 * @param options - Formatting options
 * @returns Updated lesson with formatted fullContent + summary
 */
export async function formatLessonContent(
  lesson: CompleteLesson,
  options: FormattingOptions = {}
): Promise<CompleteLesson> {
  // 1. Validation: skip if fullContent is empty/undefined
  if (!lesson.fullContent || lesson.fullContent.trim().length === 0) {
    logger.warn({ lessonId: lesson.metadata.id }, 'No fullContent to format, skipping');
    return lesson;
  }

  // 1.5. Resume mode: skip if already formatted
  if (lesson.fullContentFormatted && lesson.summary && lesson.keywords) {
    logger.info({ lessonId: lesson.metadata.id }, '⏭️ Already formatted, skipping AI formatting (resume mode)');
    return lesson;
  }

  // 2. Create AI model instance (gpt-4.1 par défaut)
  const model = createFormattingModel(options.model ?? 'gpt-4.1');

  // 3. Build prompt for formatting + summarization
  const prompt = buildFormattingPrompt(lesson.fullContent, lesson.metadata.title);

  // 4. Call AI model via LangChain ChatOpenAI.invoke()
  let result: {
    formattedContent: string;
    summary: string;
    keywords: string[];
    technologiesUsed: string[];
    technologiesMentioned: string[];
  };
  try {
    // Force JSON output via model params
    // Note: gpt-4.1 et gpt-5 supportent tous deux response_format JSON
    const modelWithJsonMode = model.bind({
      response_format: { type: 'json_object' },
    });

    // LangChain API: invoke() retourne AIMessage
    const aiMessage = await modelWithJsonMode.invoke(prompt);
    const aiResponse = aiMessage.content as string;

    // Parse JSON response
    result = JSON.parse(aiResponse.trim());
  } catch (error) {
    logger.warn({ lessonId: lesson.metadata.id, error }, 'AI formatting failed, keeping original');

    // Update stats on error
    if (options.stats) {
      options.stats.errors++;
    }

    return lesson;
  }

  // 5. Validate response
  if (
    !result.formattedContent ||
    !result.summary ||
    !result.keywords ||
    !Array.isArray(result.keywords) ||
    !result.technologiesUsed ||
    !Array.isArray(result.technologiesUsed) ||
    !result.technologiesMentioned ||
    !Array.isArray(result.technologiesMentioned)
  ) {
    logger.warn({ lessonId: lesson.metadata.id }, 'AI response missing fields, keeping original');

    // Update stats on error
    if (options.stats) {
      options.stats.errors++;
    }

    return lesson;
  }

  // 6. Safety check: formatted content shouldn't be too different (warning only, not blocking)
  const lengthDiff = Math.abs(result.formattedContent.length - lesson.fullContent.length);
  const lengthChangePercent = lengthDiff / lesson.fullContent.length;

  if (lengthChangePercent > 0.7) {
    logger.warn(
      { lessonId: lesson.metadata.id, lengthChangePercent },
      '⚠️ Formatted content length changed >70% - saving anyway for later verification'
    );
  }

  // 7. Update lesson (keep raw fullContent, add formatted version + summary + keywords + technologies)
  // IMPORTANT: Always save all formatting outputs (fullContentFormatted, summary, keywords)
  // The 70% threshold is just a warning - we save everything and verify later
  lesson.fullContentFormatted = result.formattedContent;
  lesson.summary = result.summary;
  lesson.keywords = result.keywords;
  lesson.technologiesUsed = result.technologiesUsed;
  lesson.technologiesMentioned = result.technologiesMentioned;

  // 7.5. Store per-lesson formatting metrics
  const reductionPercent = ((lesson.fullContent.length - result.formattedContent.length) / lesson.fullContent.length) * 100;
  lesson.formattingMetrics = {
    originalChars: lesson.fullContent.length,
    formattedChars: result.formattedContent.length,
    summaryChars: result.summary.length,
    reductionPercent: Math.round(reductionPercent * 100) / 100, // Round to 2 decimals
    keywordsCount: result.keywords.length,
    technologiesUsedCount: result.technologiesUsed.length,
    technologiesMentionedCount: result.technologiesMentioned.length,
  };

  // 8. Update stats on success
  if (options.stats) {
    options.stats.totalFormatted++;
    options.stats.totalSummaries++;
    options.stats.totalOriginalChars += lesson.fullContent.length;
    options.stats.totalFormattedChars += result.formattedContent.length;
    options.stats.totalSummaryChars += result.summary.length;
    options.stats.totalKeywords += result.keywords.length;
    options.stats.totalTechnologiesUsed += result.technologiesUsed.length;
    options.stats.totalTechnologiesMentioned += result.technologiesMentioned.length;

    // Calculate average reduction percentage
    if (options.stats.totalOriginalChars > 0) {
      const reduction = 1 - (options.stats.totalFormattedChars / options.stats.totalOriginalChars);
      options.stats.avgReductionPercent = reduction * 100;
    }

    // Calculate average keywords/technologies per lesson
    if (options.stats.totalFormatted > 0) {
      options.stats.avgKeywordsPerLesson = options.stats.totalKeywords / options.stats.totalFormatted;
      options.stats.avgTechnologiesUsedPerLesson = options.stats.totalTechnologiesUsed / options.stats.totalFormatted;
      options.stats.avgTechnologiesMentionedPerLesson = options.stats.totalTechnologiesMentioned / options.stats.totalFormatted;
    }
  }

  logger.info(
    {
      lessonId: lesson.metadata.id,
      model: options.model ?? 'gpt-4.1',
      originalLength: lesson.fullContent.length,
      formattedLength: result.formattedContent.length,
      summaryLength: result.summary.length,
      keywordsCount: result.keywords.length,
      technologiesUsedCount: result.technologiesUsed.length,
      technologiesMentionedCount: result.technologiesMentioned.length,
    },
    'Content formatted successfully'
  );

  return lesson;
}
