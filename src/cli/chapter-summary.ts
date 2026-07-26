/**
 * Generate high-quality chapter summaries using AI
 * Reads lesson JSONs and creates comprehensive chapter overviews
 */

import 'dotenv/config';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { existsSync } from 'fs';
import OpenAI from 'openai';
import { mdToPdf } from 'md-to-pdf';
import { createLogger } from '../utils.js';
import type { CompleteLesson } from '../types.js';

const logger = createLogger('chapter-summary');

interface ChapterSummaryOptions {
  chapterNumber: number;
  outputDir: string;
  model?: string;
  dryRun?: boolean;
  generatePdf?: boolean;
}

interface LessonBrief {
  id: string;
  title: string;
  type: string;
  summary: string;
  fullContent: string; // Full formatted content for rich AI synthesis
  keywords: string[];
  hasVideo: boolean;
  hasAudio: boolean;
  filename: string;
  thumbnail?: string; // Path to first video/media thumbnail
  url: string; // Real URL to lesson on platform
}

interface ChapterSummaryResult {
  overview: string;
  objectives: string[];
  keyTakeaways: string[];
  glossary?: Record<string, string>; // { "terme": "définition accessible" }
}

/**
 * Generate chapter summary using AI
 */
export async function generateChapterSummary(options: ChapterSummaryOptions): Promise<void> {
  const { chapterNumber, outputDir, model = 'gpt-5.1', dryRun = false, generatePdf = false } = options;

  logger.info({ chapterNumber }, `📚 Generating summary for Chapter ${chapterNumber}...`);

  // 1. Load all lessons from chapter
  const chapterDir = resolve(outputDir, `chapter-${chapterNumber}`);
  if (!existsSync(chapterDir)) {
    throw new Error(`Chapter directory not found: ${chapterDir}`);
  }

  const files = await readdir(chapterDir);
  const jsonFiles = files.filter(f => f.startsWith('lesson-') && f.endsWith('.json'));

  if (jsonFiles.length === 0) {
    throw new Error(`No lesson files found in ${chapterDir}`);
  }

  logger.info({ lessonCount: jsonFiles.length }, `📂 Found ${jsonFiles.length} lessons`);

  // 2. Load and parse all lesson JSONs
  const lessons: LessonBrief[] = [];
  let chapterTitle = '';

  for (const file of jsonFiles) {
    const filePath = resolve(chapterDir, file);
    const content = await readFile(filePath, 'utf-8');
    const lesson: CompleteLesson = JSON.parse(content);

    // Extract chapter title from first lesson
    if (!chapterTitle) {
      // Clean title: remove "➡️ Chapitre X :" prefix
      chapterTitle = lesson.chapter.title.replace(/^➡️?\s*Chapitre\s+\d+\s*:\s*/i, '').trim();
    }

    // Extract first thumbnail from media (prioritize videos)
    let thumbnail: string | undefined;
    const videoMedia = lesson.media.find(m =>
      (m.type === 'youtube' || m.type === 'vimeo' || m.type === 'video_s3') &&
      m.screenshots &&
      m.screenshots.length > 0
    );
    if (videoMedia?.screenshots?.[0]) {
      // Use absolute path for PDF generation (md-to-pdf requires absolute paths)
      // Screenshot path is already absolute: /path/to/output/{slug}/media/chapter-X/lesson-123-thumb.jpg
      thumbnail = videoMedia.screenshots[0];
      logger.info({ lessonId: lesson.metadata.id, thumbnail }, '🖼️ Thumbnail extracted (absolute path)');
    } else {
      // Use default shape.webp as fallback for lessons without video
      const shapePath = resolve(process.cwd(), 'assets', 'shape.webp');
      if (existsSync(shapePath)) {
        thumbnail = shapePath;
        logger.info({ lessonId: lesson.metadata.id, thumbnail: 'shape.webp' }, '🎨 Using default shape as thumbnail');
      } else {
        logger.info({ lessonId: lesson.metadata.id }, '⚠️ No thumbnail found for lesson');
      }
    }

    lessons.push({
      id: lesson.metadata.id,
      title: lesson.metadata.title,
      type: lesson.metadata.type,
      summary: lesson.summary || 'No summary available',
      fullContent: lesson.fullContentFormatted || lesson.summary || 'No content available', // Use rich formatted content
      keywords: lesson.keywords || [],
      hasVideo: lesson.media.some(m => m.type === 'youtube' || m.type === 'vimeo'),
      hasAudio: lesson.media.some(m => m.type === 'audio_mp3'),
      filename: file.replace('.json', '.md'),
      thumbnail,
      url: lesson.metadata.url, // Real URL from lesson metadata
    });
  }

  logger.info({ chapterTitle }, `📖 Chapter: ${chapterTitle}`);

  // 3. Build rich AI prompt
  const prompt = buildChapterSummaryPrompt(chapterNumber, chapterTitle, lessons);

  if (dryRun) {
    logger.info('\n🔍 DRY-RUN MODE - Generated prompt:\n');
    console.log(prompt);
    logger.info('\n💡 To execute: Remove --dry-run flag');
    return;
  }

  // 4. Call OpenAI API
  logger.info({ model }, '🤖 Calling OpenAI API...');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Configure reasoning effort for GPT-5
  const apiParams: any = {
    model,
    messages: [
      {
        role: 'system',
        content: 'You are an expert educational content synthesizer. Generate comprehensive, well-structured chapter summaries.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    response_format: { type: 'json_object' },
  };

  // Add high reasoning effort for GPT-5
  if (model.includes('gpt-5')) {
    apiParams.reasoning_effort = 'high';
    logger.info('🧠 Using high reasoning effort for GPT-5');
  }

  const response = await openai.chat.completions.create(apiParams);

  const result: ChapterSummaryResult = JSON.parse(response.choices[0].message.content || '{}');

  logger.info('✅ AI summary generated');

  // 5. Generate markdown with internal links (with base64 embedded images)
  const markdown = await renderChapterSummaryMarkdown(
    chapterNumber,
    chapterTitle,
    lessons,
    result
  );

  // 6. Create summaries directory at formation root
  const formationRoot = resolve(chapterDir, '..', '..');
  const summariesDir = resolve(formationRoot, 'summaries');

  if (!existsSync(summariesDir)) {
    await mkdir(summariesDir, { recursive: true });
    logger.info({ path: summariesDir }, '📁 Created summaries directory');
  }

  // 7. Save markdown file in summaries directory
  const summaryPath = resolve(summariesDir, `chapter-${chapterNumber}-summary.md`);
  await writeFile(summaryPath, markdown, 'utf-8');

  logger.info({ path: summaryPath }, '💾 Chapter summary saved');

  // 8. Generate PDF if requested
  if (generatePdf) {
    const pdfPath = resolve(summariesDir, `chapter-${chapterNumber}-summary.pdf`);
    await generatePdfFromMarkdown(markdown, pdfPath, chapterTitle);
    logger.info({ path: pdfPath }, '📄 PDF generated');
  }

  logger.info({ objectives: result.objectives.length, keyTakeaways: result.keyTakeaways.length }, '📊 Summary stats');
}

/**
 * Load tenant brand logos and convert to base64 data URLs
 */
async function loadBrandLogos(): Promise<{ logo1: string; logo2: string }> {
  try {
    const logo1Path = resolve(process.cwd(), 'assets', 'logo1.svg');
    const logo2Path = resolve(process.cwd(), 'assets', 'logo2.svg');

    const logo1Svg = await readFile(logo1Path, 'utf-8');
    const logo2Svg = await readFile(logo2Path, 'utf-8');

    const logo1Base64 = Buffer.from(logo1Svg).toString('base64');
    const logo2Base64 = Buffer.from(logo2Svg).toString('base64');

    return {
      logo1: `data:image/svg+xml;base64,${logo1Base64}`,
      logo2: `data:image/svg+xml;base64,${logo2Base64}`,
    };
  } catch (error) {
    logger.warn('⚠️ Failed to load brand logos, continuing without them');
    return { logo1: '', logo2: '' };
  }
}

/**
 * Generate PDF from markdown content
 */
async function generatePdfFromMarkdown(
  markdown: string,
  pdfPath: string,
  chapterTitle: string
): Promise<void> {
  // Load both brand logos as base64 data URLs
  const { logo1, logo2 } = await loadBrandLogos();

  // Inject Mermaid CDN
  const markdownWithMermaid = `<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>
  mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
</script>

${markdown}
`;

  logger.info({ pdfPath }, '🔨 Generating PDF with md-to-pdf...');

  let result;
  try {
    result = await mdToPdf(
      { content: markdownWithMermaid },
      {
        dest: pdfPath,
        pdf_options: {
          format: 'A4' as const,
          margin: {
            top: '20mm',
            right: '20mm',
            bottom: '20mm',
            left: '20mm',
          },
          printBackground: true,
        },
        launch_options: {
          // Wait for network idle (including Mermaid CDN script load)
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
        css: `
        /* === BRAND COLORS (minimal usage) === */
        :root {
          --brand-accent: #550CF5;
          --text-primary: #1a202c;
          --text-secondary: #4a5568;
          --border-light: #e2e8f0;
        }

        /* === BASE STYLES === */
        @page {
          @bottom-right {
            content: counter(page);
            font-size: 10pt;
            color: #718096;
            font-weight: 500;
          }
        }

        /* === ALTERNATING LOGOS ON PAGE MARGINS === */
        @page :left {
          @bottom-left {
            content: '';
            display: block;
            width: 30pt;
            height: 30pt;
            background-image: url('${logo1}');
            background-size: contain;
            background-repeat: no-repeat;
            background-position: left bottom;
          }
        }

        @page :right {
          @bottom-left {
            content: '';
            display: block;
            width: 30pt;
            height: 30pt;
            background-image: url('${logo2}');
            background-size: contain;
            background-repeat: no-repeat;
            background-position: left bottom;
          }
        }

        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
          line-height: 1.6;
          color: var(--text-primary);
          font-size: 10.5pt;
          hyphens: auto;
          position: relative;
        }

        /* === HEADINGS === */
        h1 {
          color: var(--brand-accent);
          font-size: 22pt;
          font-weight: 700;
          border-bottom: 2.5px solid var(--border-light);
          padding-bottom: 10pt;
          margin-top: 0;
          margin-bottom: 18pt;
          page-break-after: avoid;
          page-break-inside: avoid;
        }

        h2 {
          color: var(--text-primary);
          font-size: 15pt;
          font-weight: 600;
          margin-top: 22pt;
          margin-bottom: 10pt;
          page-break-after: avoid;
          page-break-before: avoid;
          page-break-inside: avoid;
        }

        h3 {
          color: var(--text-primary);
          font-size: 12.5pt;
          font-weight: 600;
          margin-top: 14pt;
          margin-bottom: 7pt;
          page-break-after: avoid;
          page-break-before: avoid;
          page-break-inside: avoid;
        }

        /* === LINKS === */
        a {
          color: var(--brand-accent);
          text-decoration: none;
          font-weight: 500;
          transition: opacity 0.2s;
        }

        a:hover {
          opacity: 0.8;
        }

        /* === PARAGRAPHS === */
        p {
          page-break-inside: avoid;
          orphans: 3;
          widows: 3;
        }

        /* === LISTS === */
        ul, ol {
          margin-top: 8pt;
          margin-bottom: 8pt;
          padding-left: 20pt;
          page-break-inside: avoid;
        }

        li {
          page-break-inside: avoid;
          margin-bottom: 4pt;
        }

        ul ul, ol ol, ul ol, ol ul {
          margin-top: 4pt;
          margin-bottom: 4pt;
        }

        /* === PARAGRAPHS === */
        p {
          margin-top: 0;
          margin-bottom: 8pt;
          text-align: justify;
        }

        /* === BOLD TEXT (just bold, no color) === */
        strong {
          font-weight: 600;
        }

        /* === EMPHASIS === */
        em {
          font-style: italic;
          color: var(--text-secondary);
        }

        /* === CODE === */
        code {
          background-color: #f7fafc;
          padding: 2pt 4pt;
          border-radius: 3pt;
          font-family: 'Courier New', monospace;
          font-size: 8.5pt;
          color: #2d3748;
        }

        pre {
          background-color: #f7fafc;
          padding: 10pt;
          border-radius: 4pt;
          border-left: 3pt solid var(--brand-accent);
          overflow-x: auto;
          margin-top: 8pt;
          margin-bottom: 8pt;
        }

        pre code {
          background-color: transparent;
          padding: 0;
        }

        /* === BLOCKQUOTES === */
        blockquote {
          margin: 12pt 0;
          padding-left: 12pt;
          border-left: 3pt solid var(--brand-accent);
          color: var(--text-secondary);
          font-style: italic;
        }

        /* === HORIZONTAL RULES === */
        hr {
          border: none;
          border-top: 1px solid var(--border-light);
          margin: 18pt 0;
        }

        /* === TABLES === */
        table {
          width: 85%;
          border-collapse: collapse;
          margin: 12pt auto;
          font-size: 9.5pt;
        }

        th {
          background-color: #f7fafc;
          font-weight: 600;
          text-align: left;
          vertical-align: top;
          padding: 6pt 8pt;
          border: 1px solid var(--border-light);
        }

        td {
          padding: 6pt 8pt;
          border: 1px solid var(--border-light);
          vertical-align: top;
        }

        /* Remove bullet points and margins in table cells */
        td ul, td ol, th ul, th ol {
          margin: 0;
          padding-left: 0;
          list-style: none;
          list-style-type: none;
          list-style-image: none;
        }

        td li, th li {
          margin: 0;
          padding: 0;
          list-style: none;
          list-style-type: none;
          list-style-image: none;
        }

        td li::before, th li::before {
          content: none;
          display: none;
        }

        tr:nth-child(even) {
          background-color: #fafafa;
        }

        /* === THUMBNAIL GRID === */
        .thumbnail-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12pt;
          margin: 16pt 0;
          page-break-inside: avoid;
        }

        .thumbnail-item {
          text-align: center;
          page-break-inside: avoid;
        }

        .thumbnail-item img {
          width: 100%;
          max-width: 80pt;
          height: auto;
          border: 1px solid var(--border-light);
          border-radius: 4pt;
        }

        .thumbnail-caption {
          margin-top: 6pt;
          font-size: 8.5pt;
          color: var(--text-secondary);
          line-height: 1.3;
        }

        /* === PRINT OPTIMIZATION === */
        @media print {
          body {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
        }

        /* === MERMAID DIAGRAMS === */
        .mermaid {
          text-align: center;
          margin: 16pt 0;
          page-break-inside: avoid;
        }
      `,
      },
    );

    if (result) {
      logger.info({ path: pdfPath, hasContent: !!result.content }, '📄 PDF generated successfully');
    }
  } catch (err: unknown) {
    logger.error({ err, type: typeof err, keys: err ? Object.keys(err) : [] }, 'PDF generation failed - full error');
    const error = err as Error;
    logger.error({ message: error?.message, stack: error?.stack, name: error?.name }, 'PDF generation failed - Error object');
    throw new Error(`Failed to generate PDF: ${error?.message || JSON.stringify(err)}`);
  }
}

/**
 * Build AI prompt with rich lesson context
 */
function buildChapterSummaryPrompt(
  chapterNumber: number,
  chapterTitle: string,
  lessons: LessonBrief[]
): string {
  const lessonsContext = lessons
    .map(
      (l, i) => `
### ${i + 1}. ${l.type} ${l.title} [ID: ${l.id}]

**Contenu complet :**
${l.fullContent}

**Mots-clés :** ${l.keywords.join(', ') || 'N/A'}
${l.hasVideo ? '🎥 Contient vidéo' : ''}${l.hasAudio ? '🎧 Contient audio' : ''}

---
`
    )
    .join('\n');

  return `# 🎯 CONTEXTE & RÔLE

Tu es un expert en synthèse pédagogique. Ton objectif : créer un résumé de chapitre naturel, engageant et actionnable pour des professionnels en formation.

**Audience** : Adultes en reconversion ou montée en compétences, qui cherchent de la clarté, des objectifs concrets et des insights pratiques.

**Ton** : Professionnel mais accessible, comme un collègue expérimenté qui partage ses connaissances. Évite le jargon inutile, mais ne simplifie pas à l'excès quand le terme technique est approprié.

---

# 📚 DONNÉES D'ENTRÉE

## CHAPITRE ${chapterNumber} : ${chapterTitle}

### Leçons complètes (${lessons.length} au total)

${lessonsContext}

---

# ✍️ TÂCHES DE SYNTHÈSE

## 1️⃣ VUE D'ENSEMBLE

Raconte l'histoire du chapitre en quelques phrases narratives. Montre la progression pédagogique (où on commence, où on va, comment on y arrive) et le bénéfice concret à l'arrivée.

**Ce qui rend une vue d'ensemble efficace** :
- Elle révèle les connexions entre les leçons (pas juste une liste)
- Elle donne envie d'apprendre en montrant le "pourquoi"
- Elle mentionne concrètement ce qu'on saura FAIRE à la fin
- Elle est spécifique, pas générique

N'hésite pas à varier la longueur selon le contenu : certains chapitres méritent plus de contexte, d'autres sont plus directs.

---

## 2️⃣ OBJECTIFS PÉDAGOGIQUES

Définis des objectifs d'apprentissage clairs et mesurables. Utilise la taxonomie de Bloom (Comprendre, Appliquer, Analyser, Créer, etc.) pour varier les niveaux.

**Structure recommandée** : \`[Verbe d'action observable] + [Ce qu'on apprend] + [Comment on sait qu'on a réussi]\`

**Bonnes pratiques** :
- Commence par des verbes d'action observables (Configurer, Analyser, Créer...)
- Inclus des critères de réussite quand pertinent (avec métriques, validations, livrables)
- Couvre différents niveaux de complexité
- Mets en gras les éléments clés (verbes, compétences, critères)

Tu peux créer entre 3 et 6 objectifs selon la richesse du chapitre. Qualité > quantité.

---

## 3️⃣ POINTS CLÉS

Extrais les insights transversaux, patterns et bonnes pratiques qui connectent les leçons. Ce ne sont PAS des résumés leçon par leçon, mais des principes de niveau supérieur.

**Format** : Chaque point = titre percutant + **paragraphe développé de 3-5 phrases minimum**

**Ce qui rend un point clé utile** :
- Il s'applique à plusieurs leçons ou situations (pattern transversal)
- Il contient des exemples concrets, chiffres, ou comparaisons
- Il donne des conseils actionnables avec détails
- Il connecte théorie et pratique avec argumentation
- Il peut inclure des mises en garde sur les pièges courants

**Exigences importantes** :
- **Développement obligatoire** : Chaque point doit faire 3-5 phrases complètes minimum, pas de points d'une seule phrase
- Utilise des tableaux markdown (max 3-4 colonnes) pour les comparaisons quand pertinent
- Ajoute des émojis avec parcimonie (🎯 ⚠️ 💡 📊)
- Chaque point doit apporter une vraie valeur, pas juste reformuler ce qui est dans les lessons
- Privilégie la profondeur et l'argumentation sur la brièveté

---

## 4️⃣ GLOSSAIRE (optionnel)

Si le chapitre contient des termes techniques importants, définis-les simplement. Pense "expliquer à un collègue intelligent mais non-technique".

**Bonnes définitions** :
- Expliquent l'utilité pratique, pas juste la définition académique
- Incluent un exemple concret quand utile
- Évitent le jargon dans l'explication
- Restent concises

Crée un glossaire seulement si nécessaire. Pas besoin de forcer 10 termes si le chapitre n'en contient que 3 importants.

---

# 🎨 FORMATAGE MARKDOWN

Tu as accès à toute la richesse de Markdown :

**Texte** : Gras, *italique*, ***gras-italique***, \`code inline\`

**Émojis** : Utilise-les avec parcimonie pour la clarté visuelle

**Tableaux** : Excellents pour les comparaisons (max 3-4 colonnes pour PDF A4)

**Listes** : À puces, numérotées, sous-listes

**Citations** : \`> texte\` pour mettre en avant des principes

**Utilise le formatage de façon naturelle** - là où ça améliore la compréhension, pas systématiquement.

---

# 📋 FORMAT DE SORTIE (JSON)

Réponds UNIQUEMENT avec ce JSON (pas de texte avant/après) :

{
  "overview": "Narrative du chapitre en quelques phrases avec formatting markdown...",
  "objectives": [
    "Objectif 1 avec verbe d'action + compétence + critère",
    "Objectif 2...",
    "... (3-6 objectifs)"
  ],
  "keyTakeaways": [
    "**Titre du pattern** : Développement argumenté avec exemples, métriques, conseils actionnables. Markdown enrichi autorisé.",
    "**Autre insight** : Développement...",
    "... (8-15+ points)"
  ],
  "glossary": {
    "Terme 1": "Définition simple avec exemple si utile",
    "Terme 2": "Définition...",
    "...": "Optionnel, seulement si pertinent"
  }
}

---

# ⚠️ PRINCIPES DIRECTEURS

1. **Naturel avant tout** : Écris comme un humain qui partage son expérience, pas comme un template
2. **Spécificité** : Préfère les exemples concrets aux généralités
3. **Actionnable** : Chaque insight doit être utile, pas juste descriptif
4. **Adapté au contexte** : Varie la longueur et la structure selon le contenu réel
5. **Langage accessible** : Simplifie le jargon quand possible, mais garde les termes techniques pertinents

Génère maintenant le résumé JSON pour le CHAPITRE ${chapterNumber} : "${chapterTitle}" (${lessons.length} leçons).`;
}

/**
 * Convert an image file to a base64 data URL for embedding in HTML
 */
async function imageToDataUrl(imagePath: string): Promise<string> {
  try {
    const imageBuffer = await readFile(imagePath);
    const base64 = imageBuffer.toString('base64');

    // Detect MIME type from file extension
    let mimeType = 'image/jpeg';
    if (imagePath.endsWith('.png')) {
      mimeType = 'image/png';
    } else if (imagePath.endsWith('.webp')) {
      mimeType = 'image/webp';
    } else if (imagePath.endsWith('.gif')) {
      mimeType = 'image/gif';
    }

    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    logger.warn({ imagePath, error }, '⚠️ Failed to convert image to base64');
    return ''; // Return empty string if image can't be loaded
  }
}

/**
 * Render markdown with internal lesson links and thumbnails
 */
async function renderChapterSummaryMarkdown(
  chapterNumber: number,
  chapterTitle: string,
  lessons: LessonBrief[],
  summary: ChapterSummaryResult
): Promise<string> {
  const date = new Date().toISOString().split('T')[0];

  // Build lesson list with real platform URLs (no thumbnails in text list)
  const lessonsList = lessons
    .map((l, i) => {
      return `${i + 1}. [${l.title}](${l.url})${l.hasVideo ? ' 🎥' : ''}${l.hasAudio ? ' 🎧' : ''}`;
    })
    .join('\n\n');

  // Build thumbnail grid for PDF (HTML for better layout control)
  // Convert images to base64 data URLs for PDF embedding
  const lessonsWithThumbs = lessons.filter(l => l.thumbnail);
  console.log(`[DEBUG] Lessons with thumbnails: ${lessonsWithThumbs.length}/${lessons.length}`);
  if (lessonsWithThumbs.length > 0) {
    console.log('[DEBUG] Sample thumbnails:', lessonsWithThumbs.slice(0, 3).map(l => ({ id: l.id, thumb: l.thumbnail })));
  }

  let thumbnailGrid: string | null = null;
  if (lessonsWithThumbs.length > 0) {
    // Convert images to base64 data URLs for Puppeteer compatibility
    // Note: file:// URLs don't work with Puppeteer due to security restrictions
    const thumbnailItems: string[] = [];
    for (const lesson of lessonsWithThumbs) {
      if (lesson.thumbnail) {
        // Convert to base64 data URL (required for Puppeteer)
        const dataUrl = await imageToDataUrl(lesson.thumbnail);
        const caption = lesson.title; // Title already contains the type emoji
        thumbnailItems.push(`  <div class="thumbnail-item">
    <a href="${lesson.url}">
      <img src="${dataUrl}" alt="${lesson.title}" />
      <div class="thumbnail-caption">${caption}</div>
    </a>
  </div>`);
      }
    }

    if (thumbnailItems.length > 0) {
      thumbnailGrid = `<div class="thumbnail-grid">
${thumbnailItems.join('\n')}
</div>`;
    }
  }

  // Build objectives list
  const objectivesList = summary.objectives.map(obj => `- ${obj}`).join('\n');

  // Build key takeaways list
  const takeawaysList = summary.keyTakeaways.map(tk => `- ${tk}`).join('\n');

  // Build glossary list (if provided)
  const glossaryList = summary.glossary && Object.keys(summary.glossary).length > 0
    ? Object.entries(summary.glossary)
        .map(([term, definition]) => `- **${term}** : ${definition}`)
        .join('\n')
    : null;

  return `# ${chapterTitle}

---

## 📖 Vue d'Ensemble

${summary.overview}


---

## 🎯 Objectifs Pédagogiques

${objectivesList}

---

## 📚 Leçons du Chapitre

${thumbnailGrid ? `${thumbnailGrid}\n` : ''}

---

## 💡 Points Clés

${takeawaysList}
${glossaryList ? `\n\n---\n\n## 📖 Glossaire\n\n${glossaryList}` : ''}
`;
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const chapterNumberArg = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const generatePdf = args.includes('--pdf');
  const model = args.find(a => a.startsWith('--model='))?.split('=')[1] || 'gpt-5.1';
  const formationOverride = args.find(a => a.startsWith('--formation='))?.split('=')[1];

  if (!chapterNumberArg) {
    console.error('Usage: tsx src/cli/chapter-summary.ts <chapter-number> [--dry-run] [--pdf] [--model=gpt-5.1] [--formation=<slug>]');
    console.error('Example: tsx src/cli/chapter-summary.ts 1');
    console.error('Example: tsx src/cli/chapter-summary.ts 1 --dry-run');
    console.error('Example: tsx src/cli/chapter-summary.ts 1 --pdf');
    console.error('Example: tsx src/cli/chapter-summary.ts 1 --model=gpt-5.1 --formation=my-course');
    process.exit(1);
  }

  const chapterNumber = parseInt(chapterNumberArg, 10);
  if (isNaN(chapterNumber) || chapterNumber < 1) {
    console.error('Chapter number must be a positive integer');
    process.exit(1);
  }

  // Determine formation slug: CLI argument overrides formation-config.json
  let slug: string;
  if (formationOverride) {
    slug = formationOverride;
    logger.info({ slug }, '🎯 Using formation from CLI argument');
  } else {
    const formationConfigPath = resolve(process.cwd(), 'formation-config.json');
    if (!existsSync(formationConfigPath)) {
      throw new Error('formation-config.json not found and no --formation argument provided');
    }
    const formationConfig = JSON.parse(await readFile(formationConfigPath, 'utf-8'));
    slug = formationConfig.formationSlug;
    logger.info({ slug }, '📋 Using formation from formation-config.json');
  }

  const outputDir = resolve(process.cwd(), 'output', slug, 'lessons');

  await generateChapterSummary({
    chapterNumber,
    outputDir,
    model,
    dryRun,
    generatePdf,
  });
}

main().catch(error => {
  logger.error({ error }, '❌ Chapter summary generation failed');
  process.exit(1);
});
