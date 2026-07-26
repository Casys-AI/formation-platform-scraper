#!/usr/bin/env node

/**
 * Generate Chapter Resources Report
 * Discovers and qualifies external resources for each chapter using Tavily search
 * Triple-optimized: Chapter-level + Tavily-native + AI-condensed queries
 */

import 'dotenv/config';
import { Command } from 'commander';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import OpenAI from 'openai';

interface QualifiedLink {
  title: string;
  url: string;
  description: string;
  qualityScore: number;
  source: 'platform' | 'tavily';
}

interface ChapterResources {
  chapterNumber: number;
  chapterTitle: string;
  lessonCount: number;
  platformLinks: QualifiedLink[];
  tavilyLinks: QualifiedLink[];
  totalResources: number;
  generatedAt: string;
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
}

/**
 * Domains to exclude from Tavily search (direct competitors only)
 * Focus: NoCode/IA/Automatisation formations in French
 */
const EXCLUDED_DOMAINS = [
  // Direct NoCode/IA competitors
  'contournement.io',
  'airmakers.fr',
  'airmakers.com',
  'makemynocode.com',
  'nocodestation.com',
  'nocode-academy.fr',

  // French entrepreneurship/business competitors
  'livementor.com',
  'shubham.school',

  // IA/Data bootcamps
  'jedha.co',
  'lewagon.com',
  'thehackingproject.org',

  // Marketplace listings (not content)
  'maformation.fr',
  'moncompteformation.gouv.fr',
  'cforpro.com',
  'diplomeo.com',
  'formation-professionnelle.fr'
];

/**
 * Load all lessons for a chapter
 */
async function loadChapterLessons(chapterPath: string): Promise<any[]> {
  const files = await readdir(chapterPath);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const lessons: any[] = [];
  for (const file of jsonFiles) {
    try {
      const content = await readFile(join(chapterPath, file), 'utf-8');
      const lesson = JSON.parse(content);
      if (lesson.content?.mainContent) {
        lessons.push(lesson);
      }
    } catch (error) {
      console.warn(chalk.yellow(`⚠️ Failed to load ${file}:`, error));
    }
  }

  return lessons;
}

/**
 * Extract a human-readable title from URL slug
 */
function extractTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    const slug = pathParts[pathParts.length - 1];

    // Convert slug to title: "hello-world-test" → "Hello World Test"
    const title = slug
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    return title;
  } catch {
    return url;
  }
}

/**
 * Extract platform links from lessons with default quality score
 * Applies intelligent deduplication:
 * - Discord: Keep only one Discord link (priority: invite links > channel links)
 * - Duplicate titles: Enrich with URL context
 */
function extractPlatformLinks(lessons: any[]): QualifiedLink[] {
  const linksMap = new Map<string, QualifiedLink>();
  let discordLink: QualifiedLink | null = null;

  for (const lesson of lessons) {
    const links = lesson.content?.links || [];
    for (const link of links) {
      // Special handling for Discord links
      if (link.url.includes('discord.com') || link.url.includes('discord.gg')) {
        if (!discordLink) {
          // First Discord link found
          discordLink = {
            title: 'Discord',
            url: link.url,
            description: `Curated resource from ${lesson.metadata?.title || 'lesson'}`,
            qualityScore: 0.85,
            source: 'platform'
          };
        } else {
          // Prioritize invite links (discord.gg or /invite/) over channel links (/channels/)
          const isInviteLink = link.url.includes('discord.gg') || link.url.includes('/invite/');
          const currentIsInvite = discordLink.url.includes('discord.gg') || discordLink.url.includes('/invite/');

          if (isInviteLink && !currentIsInvite) {
            // Replace with invite link (higher priority)
            discordLink.url = link.url;
          }
        }
        continue; // Skip adding to linksMap, will add Discord at the end
      }

      if (!linksMap.has(link.url)) {
        linksMap.set(link.url, {
          title: link.title || 'Resource',
          url: link.url,
          description: `Curated resource from ${lesson.metadata?.title || 'lesson'}`,
          qualityScore: 0.85,
          source: 'platform'
        });
      }
    }
  }

  // Add the single Discord link if found
  const links = Array.from(linksMap.values());
  if (discordLink) {
    links.unshift(discordLink); // Add Discord at the beginning
  }

  // Detect and enrich duplicate titles
  const titleCounts = new Map<string, number>();
  links.forEach(link => {
    const count = titleCounts.get(link.title) || 0;
    titleCounts.set(link.title, count + 1);
  });

  // Enrich titles for duplicates with URL context
  const enrichedLinks = links.map(link => {
    if (titleCounts.get(link.title)! > 1) {
      // Extract meaningful context from URL
      const urlContext = extractUrlContext(link.url);
      return {
        ...link,
        title: `${link.title} (${urlContext})`
      };
    }
    return link;
  });

  return enrichedLinks;
}

/**
 * Extract meaningful context from URL for title enrichment
 */
function extractUrlContext(url: string): string {
  try {
    const urlObj = new URL(url);

    // For Notion links, extract the page name from the slug
    if (urlObj.hostname.includes('notion.site')) {
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        const slug = pathParts[pathParts.length - 1];
        // Extract readable part before the UUID
        const match = slug.match(/^([^-]+(?:-[^-]+)*)-[a-f0-9]{32}/);
        if (match) {
          return match[1].split('-').slice(0, 3).join(' '); // Max 3 words
        }
      }
    }

    // For other URLs, use domain
    return urlObj.hostname.replace('www.', '').split('.')[0];
  } catch {
    return 'resource';
  }
}

/**
 * Generate condensed search query from lesson summaries using AI
 */
async function generateChapterSearchQuery(
  lessons: any[],
  chapterTitle: string
): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Collect all summaries
  const summaries = lessons
    .map(l => l.summary)
    .filter(Boolean)
    .join('\n\n');

  if (!summaries) {
    console.warn(chalk.yellow('  ⚠️ No summaries available, using chapter title only'));
    return chapterTitle;
  }

  const prompt = `Extract 3-5 main themes from these lesson summaries to create a focused search query.

Chapter: ${chapterTitle}
Lesson Count: ${lessons.length}

Summaries:
${summaries}

Requirements:
- Output: Concise search query (100-150 chars max)
- Format: "theme1, theme2, theme3" (keywords or short phrases)
- Language: French
- Focus on actionable topics (tools, techniques, concepts)

Output: Just the search query, nothing else.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: prompt }],
      reasoning_effort: 'low',
      max_completion_tokens: 300
    } as any);

    const query = response.choices[0].message.content?.trim() || chapterTitle;

    // Validate length (Tavily limit is 400 chars)
    if (query.length > 400) {
      console.warn(chalk.yellow(`  ⚠️ Query too long (${query.length} chars), truncating`));
      return query.slice(0, 397) + '...';
    }

    return query;
  } catch (error) {
    console.warn(chalk.yellow('  ⚠️ Failed to generate query, using chapter title'), error);
    return chapterTitle;
  }
}

/**
 * Search with Tavily API
 */
async function searchWithTavily(query: string): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    console.warn(chalk.yellow('  ⚠️ TAVILY_API_KEY not set, skipping discovery'));
    return [];
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'advanced',
        max_results: 12,
        include_domains: [],
        exclude_domains: EXCLUDED_DOMAINS,
        include_answer: false,
        include_raw_content: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(chalk.yellow(`  ⚠️ Tavily API error: ${response.status}`));
      console.warn(chalk.gray(`  Response: ${errorText}`));
      return [];
    }

    const data = await response.json() as TavilyResponse;
    console.log(chalk.gray(`  Tavily returned ${data.results?.length || 0} results`));
    if (data.results && data.results.length > 0) {
      console.log(chalk.gray(`  Sample result: ${data.results[0].title} (score: ${data.results[0].score})`));
    }
    return data.results || [];
  } catch (error) {
    console.warn(chalk.yellow('  ⚠️ Tavily search failed:'), error);
    return [];
  }
}

/**
 * Analyze Tavily results with AI to filter out training ads and enrich with summaries
 * L'IA décide complètement quels liens accepter, sans limite de score
 */
async function analyzeAndQualifyTavilyResults(
  results: TavilyResult[]
): Promise<QualifiedLink[]> {
  if (results.length === 0) return [];

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Debug: Show Tavily results before analysis
  console.log(chalk.cyan('  📋 Résultats Tavily bruts:'));
  results.forEach((r, i) => {
    console.log(chalk.gray(`     [${i + 1}] ${r.title} (score: ${r.score})`));
    console.log(chalk.gray(`         URL: ${r.url}`));
  });

  try {
    // Batch analyze results
    const analysisPrompt = `Tu es un assistant qui analyse des résultats de recherche pour créer une liste de ressources pédagogiques.

CONSIGNE: Analyse TOUS les ${results.length} résultats ci-dessous. Pour chaque résultat, décide s'il est PERTINENT ou NON.

Un résultat est PERTINENT si c'est un contenu ÉDUCATIF et ACTIONNABLE pour entrepreneurs :
✅ Article, blog, guide ou tutoriel sur l'ENTREPRENEURIAT (création d'entreprise, gestion, stratégie)
✅ Guide pratique sur les DÉMARCHES ADMINISTRATIVES (statuts, URSSAF, comptabilité, juridique)
✅ Ressources sur la STRATÉGIE BUSINESS (validation d'offre, pricing, positionnement, MVP)
✅ Guides MARKETING / VENTE (acquisition client, génération de leads, prospection)
✅ Documentation d'outils NO-CODE/BUSINESS (Airtable, Make.com, Zapier, Softr, Webflow)
✅ Cas d'usage concrets d'AUTOMATISATION ou création d'apps sans coder
✅ Retours d'expérience d'ENTREPRENEURS sur leur lancement/croissance

Un résultat est NON PERTINENT si:
❌ Plateforme de vente de cours (Udemy, Coursera, Tuto.com) ou formation payante
❌ Page de vente pure sans contenu éducatif accessible
❌ Article TECHNIQUE sur la PROGRAMMATION (make/Makefile, C++, compilation, code)
❌ Contenu en chinois, japonais ou langue non FR/EN
❌ Sujets hors contexte (grammaire, linguistique, sujets académiques sans lien business)
❌ Profils LinkedIn/Malt ou annonces de services sans guide détaillé

RÉSULTATS À ANALYSER (${results.length} résultats):
${results.map((r, i) => `
[${i + 1}] ${r.title}
URL: ${r.url}
Contenu: ${r.content.slice(0, 400)}...
`).join('\n')}

RETOURNE un array JSON avec exactement ${results.length} objets.
Pour chaque résultat PERTINENT: {"index": N, "accept": true, "summary": "Un résumé informatif de 300-400 caractères qui explique ce que l'utilisateur apprendra"}
Pour chaque résultat NON PERTINENT: {"index": N, "accept": false, "reason": "Raison courte"}

Exemple de réponse attendue:
[
  {"index": 1, "accept": true, "summary": "Guide complet sur l'automatisation avec Airtable..."},
  {"index": 2, "accept": false, "reason": "Cours payant Udemy"},
  {"index": 3, "accept": true, "summary": "Documentation officielle Jotform expliquant..."}
]

COMMENCE TON ANALYSE MAINTENANT:`;

    // Calculate required tokens: ~100 tokens per result (index + accept + summary/reason)
    const estimatedTokens = results.length * 100;
    const maxTokens = Math.max(2000, Math.min(16000, estimatedTokens + 1000));

    console.log(chalk.gray(`  💭 Estimation: ${results.length} résultats × 100 tokens ≈ ${estimatedTokens} tokens (max: ${maxTokens})`));

    const response = await openai.chat.completions.create({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: analysisPrompt }],
      reasoning_effort: 'low',
      max_completion_tokens: maxTokens
    } as any);

    let analysisText = response.choices[0].message.content || '[]';

    // Debug: Show AI response
    console.log(chalk.cyan('  📝 Réponse IA complète:'));
    console.log(chalk.gray(analysisText));

    // Remove markdown code blocks if present
    analysisText = analysisText.replace(/^```(?:json)?\s*/gm, '').replace(/```\s*$/gm, '').trim();

    // Parse JSON response
    let analysis: Array<{ index: number; accept: boolean; summary?: string }> = [];
    try {
      analysis = JSON.parse(analysisText);
      console.log(chalk.cyan(`  📊 Analyse parsée: ${analysis.length} résultats`));
    } catch (e) {
      console.warn(chalk.yellow('  ⚠️ Erreur parsing analyse:'), (e as Error).message);
      console.log(chalk.gray('  Raw response:'), analysisText.slice(0, 200));
      // Fallback: accept all results
      analysis = results.map((_, i) => ({ index: i + 1, accept: true }));
    }

    // Transform accepted results
    const qualifiedLinks: QualifiedLink[] = [];
    const rejectedCount = analysis.filter(item => !item.accept).length;

    // Log rejections for debugging
    if (rejectedCount > 0) {
      console.log(chalk.yellow(`  ⚠️ ${rejectedCount} ressources rejetées :`));
      analysis.filter(item => !item.accept).forEach(item => {
        const result = results[item.index - 1];
        const reason = (item as any).reason || 'Non spécifié';
        console.log(chalk.gray(`     - [${item.index}] ${result?.title || 'Unknown'}: ${reason}`));
      });
    }

    for (const item of analysis) {
      if (item.accept && item.index > 0 && item.index <= results.length) {
        const result = results[item.index - 1];
        qualifiedLinks.push({
          title: result.title,
          url: result.url,
          description: item.summary || result.content.slice(0, 400),
          qualityScore: result.score,
          source: 'tavily'
        });
      }
    }

    return qualifiedLinks;
  } catch (error) {
    console.warn(chalk.yellow('  ⚠️ Analyse échouée'), error);
    // Fallback: return raw results
    return results.map(r => ({
      title: r.title,
      url: r.url,
      description: r.content.slice(0, 400),
      qualityScore: r.score,
      source: 'tavily'
    }));
  }
}

/**
 * Generate multiple search queries from chapter content
 */
async function generateMultipleSearchQueries(
  lessons: any[],
  chapterTitle: string
): Promise<string[]> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const summaries = lessons
    .map(l => l.summary)
    .filter(Boolean)
    .join('\n\n');

  if (!summaries) {
    console.warn(chalk.yellow('  ⚠️ No summaries available'));
    return [chapterTitle];
  }

  const prompt = `Tu es un assistant de recherche. Analyse ce chapitre et génère 3-5 requêtes de recherche différentes pour trouver les meilleures ressources pédagogiques.

Chapitre: ${chapterTitle}
Nombre de leçons: ${lessons.length}

Résumés des leçons:
${summaries}

CONSIGNE: Analyse le CONTENU du chapitre pour comprendre le sujet principal, puis génère exactement 2 requêtes de recherche complémentaires ADAPTÉES au thème :

ÉTAPE 1 - Identifier le thème du chapitre :
- Si c'est sur la CRÉATION D'ENTREPRISE / JURIDIQUE → focus sur statuts, démarches administratives, URSSAF, comptabilité, immatriculation
- Si c'est sur l'OFFRE / PRODUIT / MARCHÉ → focus sur validation d'offre, MVP, pricing, étude de marché, positionnement
- Si c'est sur l'ACQUISITION CLIENT / MARKETING → focus sur stratégies marketing, génération de leads, vente, prospection
- Si c'est sur l'AUTOMATISATION / IA / OUTILS NO-CODE → focus sur outils (Make.com, Airtable, Zapier) et automatisation business
- Si c'est sur la GESTION / OPÉRATIONS → focus sur process, organisation, productivité

ÉTAPE 2 - Générer 2 requêtes adaptées :
1. Une requête sur les concepts / outils / méthodes du thème identifié
2. Une requête sur les guides pratiques / cas d'usage / retours d'expérience

IMPORTANT - Règles spécifiques :
- Si le chapitre mentionne "Make" dans un contexte automation → utilise "Make.com" ou "Make automatisation"
- Si le chapitre parle d'IA → précise "IA générative" ou "ChatGPT" (pas juste "IA")
- Évite les termes génériques, sois spécifique au sujet du chapitre
- Privilégie les guides PRATIQUES et ressources ACTIONNABLES

Chaque requête doit:
- Être concise (80-120 caractères)
- En français
- Contenir des mots-clés pertinents séparés par des virgules

Retourne UNIQUEMENT un array JSON avec exactement 2 strings:
["requête 1", "requête 2"]

Exemples selon le thème :
Thème JURIDIQUE : ["création entreprise France statuts juridiques micro-entreprise SASU", "guide pratique démarches administratives URSSAF immatriculation CFE"]
Thème OFFRE/MARCHÉ : ["validation offre MVP pricing positionnement stratégie produit", "étude de marché persona clients besoins pain points"]
Thème AUTOMATION : ["outils no-code Make.com Airtable Zapier automatisation workflows", "cas usage automatisation business CRM facturation emails"]`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: prompt }],
      reasoning_effort: 'low',
      max_completion_tokens: 500
    } as any);

    let queriesText = response.choices[0].message.content?.trim() || '[]';

    // Remove markdown code blocks if present
    queriesText = queriesText.replace(/^```(?:json)?\s*/gm, '').replace(/```\s*$/gm, '').trim();

    const queries = JSON.parse(queriesText) as string[];

    // Validate and limit to 2
    const validQueries = queries
      .filter(q => typeof q === 'string' && q.length > 0 && q.length <= 400)
      .slice(0, 2);

    if (validQueries.length === 0) {
      console.warn(chalk.yellow('  ⚠️ No valid queries generated, using chapter title'));
      return [chapterTitle];
    }

    return validQueries;
  } catch (error) {
    console.warn(chalk.yellow('  ⚠️ Failed to generate queries, using chapter title'), error);
    return [chapterTitle];
  }
}

/**
 * Discover resources using Tavily (AI-driven multi-query approach)
 */
async function discoverTavilyResources(
  lessons: any[],
  chapterTitle: string
): Promise<QualifiedLink[]> {
  try {
    // Step 1: AI generates multiple search queries
    console.log(chalk.gray('  🤖 IA génère plusieurs requêtes de recherche...'));
    const queries = await generateMultipleSearchQueries(lessons, chapterTitle);
    console.log(chalk.cyan(`  📋 ${queries.length} requêtes générées:`));
    queries.forEach((q, i) => console.log(chalk.gray(`     ${i + 1}. "${q}"`)));

    // Step 2: Search Tavily for each query
    const allResults: TavilyResult[] = [];
    const seenUrls = new Set<string>();

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      console.log(chalk.gray(`  🔍 Recherche ${i + 1}/${queries.length}: "${query}"`));

      const results = await searchWithTavily(query);

      // Deduplicate by URL
      const newResults = results.filter(r => {
        if (seenUrls.has(r.url)) return false;
        seenUrls.add(r.url);
        return true;
      });

      console.log(chalk.gray(`     → ${newResults.length} nouveaux résultats (${results.length - newResults.length} doublons ignorés)`));
      allResults.push(...newResults);

      // Small delay between searches
      if (i < queries.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(chalk.cyan(`  📊 Total: ${allResults.length} résultats uniques collectés`));

    if (allResults.length === 0) {
      return [];
    }

    // Step 3: AI analyzes & qualifies ALL results at once
    console.log(chalk.gray('  🧠 IA analyse et filtre tous les résultats...'));
    const qualifiedLinks = await analyzeAndQualifyTavilyResults(allResults);

    console.log(chalk.cyan(`  ✅ ${qualifiedLinks.length}/${allResults.length} ressources qualifiées`));

    return qualifiedLinks;
  } catch (error) {
    console.warn(chalk.yellow('  ⚠️ Découverte Tavily échouée:'), error);
    return [];
  }
}

/**
 * Generate student-friendly resource guide
 */
function generateResourcesReport(resources: ChapterResources): string {
  const lines: string[] = [];

  // Header - Student friendly
  lines.push(`# 📚 ${resources.chapterTitle}`);
  lines.push('');
  lines.push(`> **Fiche de ressources** • ${resources.lessonCount} leçons • ${resources.totalResources} ressources`);
  lines.push('');

  // Quick intro
  if (resources.totalResources > 0) {
    lines.push('Cette fiche regroupe toutes les ressources utiles pour approfondir ce chapitre. Tu y trouveras les liens recommandés par la formation ainsi que des ressources complémentaires sélectionnées pour toi.');
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // Platform Resources - Student friendly
  if (resources.platformLinks.length > 0) {
    lines.push('## 🎯 Ressources de la formation');
    lines.push('');
    lines.push(`Ces ressources ont été sélectionnées par tes formateurs. Elles sont **directement liées au contenu du chapitre**.`);
    lines.push('');

    for (const link of resources.platformLinks) {
      // Determine display title based on generic patterns
      let displayTitle = link.title;

      if (link.title.startsWith('Vidéo YouTube')) {
        // Extract title from URL slug
        displayTitle = extractTitleFromUrl(link.url);
      } else if (
        link.title.startsWith('Lien vers') ||
        link.title.startsWith('Lien d\'invitation') ||
        link.title === '🔗' ||
        link.title === 'Resource' ||
        link.title === 'Pricing' ||
        link.title.toLowerCase() === 'pricing'
      ) {
        // Use full URL for generic titles
        displayTitle = link.url;
      }

      lines.push(`- 🔗 **[${displayTitle}](${link.url})**`);
    }
    lines.push('');
  }

  // Tavily Resources - Student friendly
  if (resources.tavilyLinks.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## 🌐 Pour aller plus loin');
    lines.push('');
    lines.push(`Voici ${resources.tavilyLinks.length} ressources complémentaires trouvées sur le web pour approfondir les concepts de ce chapitre :`);
    lines.push('');

    for (const link of resources.tavilyLinks) {
      const scoreEmoji = link.qualityScore >= 0.9 ? '⭐' : link.qualityScore >= 0.8 ? '✨' : '📌';
      lines.push(`### ${scoreEmoji} [${link.title}](${link.url})`);
      lines.push('');
      lines.push(link.description);
      lines.push('');
    }
  }

  // No resources case
  if (resources.totalResources === 0) {
    lines.push('## 💡 Aucune ressource pour le moment');
    lines.push('');
    lines.push('Aucune ressource externe n\'a été trouvée pour ce chapitre. Concentre-toi sur le contenu des leçons !');
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('_💡 Astuce : Enregistre cette fiche dans tes favoris pour y revenir facilement pendant ton apprentissage._');
  lines.push('');

  return lines.join('\n');
}

/**
 * Process a single chapter
 */
async function processChapter(
  chapterNumber: number,
  lessonsDir: string,
  outputDir: string
): Promise<void> {
  const chapterPath = join(lessonsDir, `chapter-${chapterNumber}`);

  if (!existsSync(chapterPath)) {
    console.log(chalk.yellow(`⚠️ Chapter ${chapterNumber} not found, skipping`));
    return;
  }

  console.log(chalk.cyan(`\n📖 Processing Chapter ${chapterNumber}...`));

  // Load lessons
  const lessons = await loadChapterLessons(chapterPath);
  if (lessons.length === 0) {
    console.log(chalk.yellow(`  ⚠️ No lessons found in chapter ${chapterNumber}`));
    return;
  }

  const chapterTitle = lessons[0]?.chapter?.title || `Chapter ${chapterNumber}`;
  console.log(chalk.gray(`  Found ${lessons.length} lessons`));

  // Extract platform links
  const platformLinks = extractPlatformLinks(lessons);
  console.log(chalk.gray(`  Extracted ${platformLinks.length} platform links`));

  // Discover Tavily resources
  const tavilyLinks = await discoverTavilyResources(lessons, chapterTitle);
  console.log(chalk.gray(`  Discovered ${tavilyLinks.length} Tavily resources`));

  // Build resources object
  const resources: ChapterResources = {
    chapterNumber,
    chapterTitle,
    lessonCount: lessons.length,
    platformLinks,
    tavilyLinks,
    totalResources: platformLinks.length + tavilyLinks.length,
    generatedAt: new Date().toISOString()
  };

  // Generate report
  const report = generateResourcesReport(resources);

  // Save report in centralized resources directory at formation root
  const resourcesDir = join(outputDir, 'resources');
  await mkdir(resourcesDir, { recursive: true });
  const reportPath = join(resourcesDir, `chapter-${chapterNumber}-resources.md`);
  await writeFile(reportPath, report, 'utf-8');

  console.log(chalk.green(`  ✅ Resources saved: ${reportPath}`));
}

/**
 * Main command
 */
const program = new Command();

program
  .name('resources')
  .description('Generate chapter resources report using Tavily discovery')
  .argument('[course-slug]', 'Course slug (auto-detected from config if not provided)')
  .argument('[config-path]', 'Config file path (default: extraction-config.json)', 'extraction-config.json')
  .option('-c, --chapter <number>', 'Generate resources for specific chapter only')
  .action(async (courseSlugArg: string | undefined, configPath: string, options: { chapter?: string }) => {
    try {
      console.log(chalk.blue.bold('\n🔍 Chapter Resources Generator\n'));

      // Load config
      let courseSlug = courseSlugArg;
      let configChapters: number[] | undefined;

      try {
        const config = loadConfig(configPath);
        console.log(chalk.gray(`Config loaded: mode=${config.mode}, chapters=${config.chapters?.join(',') || 'all'}`));

        // Extract slug from formationUrl if not provided
        if (!courseSlug) {
          courseSlug = config.formationUrl.split('/').pop() || '';
          console.log(chalk.gray(`Auto-detected slug: ${courseSlug}`));
        }

        // Use configured chapters if in 'chapters' mode
        if (config.mode === 'chapters' && config.chapters && config.chapters.length > 0) {
          configChapters = config.chapters;
          console.log(chalk.gray(`Using chapters from config: ${configChapters.join(', ')}`));
        }
      } catch (error) {
        console.warn(chalk.yellow(`⚠️ Could not load config (${configPath})`));
      }

      // Validate slug
      if (!courseSlug) {
        console.error(chalk.red('❌ Could not determine course slug. Provide as argument or check config.'));
        process.exit(1);
      }

      // Construct paths
      const outputDir = resolve(process.cwd(), 'output', courseSlug);
      const lessonsDir = join(outputDir, 'lessons');

      if (!existsSync(lessonsDir)) {
        console.error(chalk.red(`❌ Lessons directory not found: ${lessonsDir}`));
        process.exit(1);
      }

      // Determine which chapters to process
      let chaptersToProcess: number[] = [];

      if (options.chapter) {
        // Command-line option takes priority
        chaptersToProcess = [parseInt(options.chapter, 10)];
        console.log(chalk.gray(`Processing chapter ${options.chapter} (from command-line)`));
      } else if (configChapters && configChapters.length > 0) {
        // Use config chapters
        chaptersToProcess = configChapters;
      } else {
        // Scan all chapters
        const entries = await readdir(lessonsDir, { withFileTypes: true });
        chaptersToProcess = entries
          .filter(e => e.isDirectory() && e.name.startsWith('chapter-'))
          .map(e => parseInt(e.name.replace('chapter-', ''), 10))
          .sort((a, b) => a - b);
        console.log(chalk.gray(`Scanning all chapters: ${chaptersToProcess.join(', ')}`));
      }

      if (chaptersToProcess.length === 0) {
        console.error(chalk.red('❌ No chapters to process'));
        process.exit(1);
      }

      // Process each chapter
      for (const chapterNum of chaptersToProcess) {
        await processChapter(chapterNum, lessonsDir, outputDir);
      }

      console.log(chalk.green.bold('\n✅ Chapter resources generation complete!\n'));

    } catch (error) {
      console.error(chalk.red('❌ Failed to generate resources:'), error);
      process.exit(1);
    }
  });

program.parse();
