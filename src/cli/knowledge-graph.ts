/**
 * Knowledge Graph Generator
 * Generates a pedagogical knowledge graph from extracted lesson data
 * Outputs HTML and Markdown reports showing technology usage, concept progression, and chapter analysis
 */

import 'dotenv/config';
import { writeFile } from 'fs/promises';
import { resolve, join } from 'path';
import { createLogger } from '../utils.js';
import { generateKnowledgeGraph } from '../pedagogical-analyzer.js';
import { generateHTMLTemplate, generateMarkdownTemplate } from '../knowledge-graph-template.js';
import type { ExtractionConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { mdToPdf } from 'md-to-pdf';

const logger = createLogger('knowledge-graph');

/**
 * Main function: Generate knowledge graph
 */
export async function generateKnowledgeGraphCommand(courseSlugArg?: string, chaptersArg?: string): Promise<void> {
  try {
    logger.info('🚀 Starting knowledge graph generation...');

    let courseSlug: string;

    // Use provided slug argument, or fallback to extraction-config.json
    if (courseSlugArg) {
      courseSlug = courseSlugArg;
      logger.info({ courseSlug }, 'Using course slug from argument');
    } else {
      // Load extraction config to get course slug
      const config: ExtractionConfig = await loadConfig();
      const extractedSlug = extractCourseSlug(config.formationUrl);

      if (!extractedSlug) {
        throw new Error('Could not extract course slug from formationUrl in extraction-config.json');
      }

      courseSlug = extractedSlug;
      logger.info({ courseSlug }, 'Detected course slug from config');
    }

    // Parse chapters if provided; otherwise include all chapters
    let chapters: number[] | undefined;
    if (chaptersArg) {
      chapters = chaptersArg.split(',').map((ch) => parseInt(ch.trim(), 10));
      logger.info({ chapters }, `📚 Filtering to specific chapters (from argument)`);
    }

    // Output directory
    const outputDir = resolve(process.cwd(), 'output');
    const courseOutputDir = join(outputDir, courseSlug);

    // Generate the knowledge graph
    logger.info('📊 Analyzing lessons and generating knowledge graph...');
    const graph = await generateKnowledgeGraph(outputDir, courseSlug, { chapters });

    logger.info(
      {
        totalLessons: graph.totalLessons,
        totalChapters: graph.totalChapters,
        totalTechnologies: graph.statistics.totalTechnologies,
        totalKeywords: graph.statistics.totalKeywords,
      },
      'Knowledge graph generated successfully'
    );

    // Generate HTML report
    logger.info('📄 Generating HTML report...');
    const htmlContent = generateHTMLTemplate(graph);
    const htmlPath = join(courseOutputDir, `${courseSlug}-kg.html`);
    await writeFile(htmlPath, htmlContent, 'utf-8');
    logger.info({ path: htmlPath }, '✅ HTML report saved');

    // Generate Markdown report
    logger.info('📝 Generating Markdown report...');
    const markdownContent = generateMarkdownTemplate(graph);
    const markdownPath = join(courseOutputDir, `${courseSlug}-kg.md`);
    await writeFile(markdownPath, markdownContent, 'utf-8');
    logger.info({ path: markdownPath }, '✅ Markdown report saved');

    // Generate PDF report
    logger.info('📄 Generating PDF report...');
    const pdfPath = join(courseOutputDir, `${courseSlug}-kg.pdf`);
    try {
      await mdToPdf(
        { content: markdownContent },
        {
          dest: pdfPath,
          pdf_options: {
            format: 'A4',
            margin: {
              top: '20mm',
              right: '20mm',
              bottom: '20mm',
              left: '20mm',
            },
          },
        }
      );
      logger.info({ path: pdfPath }, '✅ PDF report saved');
    } catch (error: any) {
      logger.error({ error: error.message }, '❌ Failed to generate PDF');
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 KNOWLEDGE GRAPH GENERATION COMPLETE');
    console.log('='.repeat(60));
    console.log(`\n📚 Course: ${graph.courseTitle}`);
    console.log(`📖 Total lessons: ${graph.totalLessons}`);
    console.log(`📑 Total chapters: ${graph.totalChapters}`);
    console.log(`🔧 Total technologies: ${graph.statistics.totalTechnologies}`);
    console.log(`💡 Total concepts: ${graph.statistics.totalKeywords}`);
    console.log(`\n📊 Top 5 Technologies:`);
    graph.topTechnologies.slice(0, 5).forEach((tech, idx) => {
      console.log(
        `   ${idx + 1}. ${tech.name} - ${tech.count} leçons (introduit: Ch.${tech.firstAppearance.chapterNumber})`
      );
    });
    console.log(`\n📄 Reports generated:`);
    console.log(`   • HTML: ${htmlPath}`);
    console.log(`   • Markdown: ${markdownPath}`);
    console.log(`   • PDF: ${pdfPath}`);
    console.log('\n' + '='.repeat(60) + '\n');
  } catch (error: any) {
    logger.error({ error: error.message, stack: error.stack }, 'Failed to generate knowledge graph');
    throw error;
  }
}

/**
 * Extract course slug from formation URL
 */
function extractCourseSlug(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter((p) => p);
    // URL format: .../mon-espace/formations/{course-slug}
    const formationsIdx = pathParts.indexOf('formations');
    if (formationsIdx !== -1 && pathParts.length > formationsIdx + 1) {
      return pathParts[formationsIdx + 1];
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const courseSlugArg = process.argv[2]; // Get slug from command line
  const chaptersArg = process.argv[3]; // Get chapters from command line (e.g., "2,3,4,7,8,9")
  generateKnowledgeGraphCommand(courseSlugArg, chaptersArg).catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
