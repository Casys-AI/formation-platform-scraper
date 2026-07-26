import { PedagogicalGraph } from './types';

/**
 * Generate HTML template for knowledge graph
 */
export function generateHTMLTemplate(graph: PedagogicalGraph): string {
  const maxBarLength = 50; // For technology frequency bars (Markdown)

  // Helper: Generate progress bar (for Markdown)
  const generateBar = (count: number, maxCount: number): string => {
    const barLength = Math.round((count / maxCount) * maxBarLength);
    return '█'.repeat(barLength);
  };

  // Helper: Count frequencies from lessons and filter/sort with threshold
  const countFromLessons = (lessons: any[], field: string): Map<string, number> => {
    const counts = new Map<string, number>();
    lessons.forEach(lesson => {
      const items = lesson[field] || [];
      items.forEach((item: string) => {
        counts.set(item, (counts.get(item) || 0) + 1);
      });
    });
    return counts;
  };

  const filterAndSortWithCounts = (counts: Map<string, number>, threshold: number = 2, limit?: number): Array<{name: string, count: number}> => {
    const items = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .filter(item => item.count >= threshold)
      .sort((a, b) => b.count - a.count);

    return limit ? items.slice(0, limit) : items;
  };

  // Helper: Generate bi-color bar (for HTML)
  const generateBiColorBar = (usedCount: number, mentionedCount: number, maxCount: number): string => {
    const totalCount = usedCount + mentionedCount;
    const usedPercent = (usedCount / maxCount) * 100;
    const mentionedPercent = (mentionedCount / maxCount) * 100;

    return `
      <div class="bar-container">
        <div class="bar-segment-used" style="width: ${usedPercent}%;" title="✅ ${usedCount} utilisée"></div>
        <div class="bar-segment-mentioned" style="width: ${mentionedPercent}%;" title="💬 ${mentionedCount} mentionnée"></div>
      </div>
    `;
  };

  // Top 15 technologies for display
  const top15Techs = graph.topTechnologies.slice(0, 15);
  const maxTechCount = top15Techs[0]?.count || 1;

  // Top 15 keywords for display
  const top15Keywords = graph.topKeywords.slice(0, 15);
  const maxKeywordCount = top15Keywords[0]?.count || 1;

  // Technology matrix HTML
  const matrixHTML = generateTechnologyMatrixHTML(graph);

  return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>📊 ${graph.courseTitle} - Cartographie Pédagogique</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background: #f5f5f5;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }

        h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            color: #2c3e50;
        }

        .subtitle {
            font-size: 1.1em;
            color: #7f8c8d;
            margin-bottom: 30px;
        }

        .section {
            margin: 40px 0;
            padding: 30px;
            background: #f8f9fa;
            border-radius: 8px;
            border-left: 4px solid #3498db;
        }

        .section h2 {
            font-size: 1.8em;
            margin-bottom: 20px;
            color: #2c3e50;
        }

        .overview-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }

        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }

        .stat-card .number {
            font-size: 3em;
            font-weight: bold;
            color: #3498db;
        }

        .stat-card .label {
            font-size: 1em;
            color: #7f8c8d;
            margin-top: 5px;
        }

        .bar-chart {
            margin: 20px 0;
        }

        .bar-item {
            margin: 12px 0;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .bar-label {
            min-width: 150px;
            font-weight: 500;
            color: #2c3e50;
        }

        .bar-container {
            flex: 1;
            max-width: 400px;
            height: 24px;
            background: #ecf0f1;
            border-radius: 12px;
            overflow: hidden;
            position: relative;
            display: flex;
        }

        .bar-segment-used {
            background: linear-gradient(90deg, #27ae60, #2ecc71);
            height: 100%;
            transition: width 0.3s ease;
        }

        .bar-segment-mentioned {
            background: linear-gradient(90deg, #95a5a6, #bdc3c7);
            height: 100%;
            transition: width 0.3s ease;
        }

        .bar-count {
            margin-left: 10px;
            color: #2c3e50;
            font-size: 0.9em;
            white-space: nowrap;
        }

        .bar-detail {
            font-size: 0.85em;
            color: #7f8c8d;
            margin-left: 5px;
        }

        .chapter-block {
            margin: 25px 0;
            padding: 20px;
            background: white;
            border-radius: 8px;
            border-left: 4px solid #9b59b6;
        }

        .chapter-header {
            font-size: 1.3em;
            font-weight: bold;
            color: #2c3e50;
            margin-bottom: 15px;
        }

        .chapter-meta {
            display: flex;
            gap: 30px;
            margin: 15px 0;
            flex-wrap: wrap;
        }

        .chapter-meta-item {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.85em;
            font-weight: 500;
            margin: 4px;
        }

        .badge-new {
            background: #d4edda;
            color: #155724;
        }

        .badge-reused {
            background: #d1ecf1;
            color: #0c5460;
        }

        .badge-concept {
            background: #fff3cd;
            color: #856404;
        }

        .tech-list, .keyword-list {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
            margin: 10px 0;
        }

        .matrix {
            overflow-x: auto;
            margin: 20px 0;
        }

        .matrix table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            font-size: 0.9em;
        }

        .matrix th, .matrix td {
            padding: 12px 8px;
            text-align: center;
            border: 1px solid #dee2e6;
        }

        .matrix th {
            background: #3498db;
            color: white;
            font-weight: 600;
        }

        .matrix th.tech-name {
            text-align: left;
            background: #2c3e50;
        }

        .matrix td {
            background: #f8f9fa;
        }

        .matrix .intensity-0 { background: #ffffff; }
        .matrix .intensity-1 { background: #e3f2fd; }
        .matrix .intensity-2 { background: #bbdefb; }
        .matrix .intensity-3 { background: #90caf9; }
        .matrix .intensity-4 { background: #64b5f6; }
        .matrix .intensity-5 { background: #42a5f5; }
        .matrix .intensity-6 { background: #2196f3; color: white; }
        .matrix .intensity-7 { background: #1e88e5; color: white; }
        .matrix .intensity-8 { background: #1976d2; color: white; }
        .matrix .intensity-9 { background: #1565c0; color: white; }

        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 2px solid #dee2e6;
            text-align: center;
            color: #7f8c8d;
            font-size: 0.9em;
        }

        @media print {
            body {
                background: white;
                padding: 0;
            }
            .container {
                box-shadow: none;
                padding: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 ${graph.courseTitle}</h1>
        <p class="subtitle">Cartographie Pédagogique - ${graph.totalLessons} leçons, ${graph.totalChapters} chapitres</p>

        <!-- Vue d'ensemble -->
        <div class="section">
            <h2>🎯 Vue d'ensemble</h2>
            <div class="overview-grid">
                <div class="stat-card">
                    <div class="number">${graph.totalLessons}</div>
                    <div class="label">Leçons</div>
                </div>
                <div class="stat-card">
                    <div class="number">${graph.totalChapters}</div>
                    <div class="label">Chapitres</div>
                </div>
                <div class="stat-card">
                    <div class="number">${graph.statistics.totalTechnologies}</div>
                    <div class="label">Technologies</div>
                </div>
                <div class="stat-card">
                    <div class="number">${graph.statistics.totalKeywords}</div>
                    <div class="label">Concepts</div>
                </div>
                <div class="stat-card">
                    <div class="number">${graph.statistics.avgTechnologiesPerLesson.toFixed(1)}</div>
                    <div class="label">Techno / Leçon</div>
                </div>
                <div class="stat-card">
                    <div class="number">${graph.statistics.avgKeywordsPerLesson.toFixed(1)}</div>
                    <div class="label">Concepts / Leçon</div>
                </div>
            </div>
        </div>

        <!-- Top Technologies -->
        <div class="section">
            <h2>🔥 Technologies par fréquence</h2>
            <div class="bar-chart">
                ${top15Techs
                  .map(
                    (tech) => `
                <div class="bar-item">
                    <div class="bar-label">${tech.name}</div>
                    ${generateBiColorBar(tech.usedCount, tech.mentionedCount, maxTechCount)}
                    <div class="bar-count">
                        <strong>${tech.count}</strong> leçons
                        <span class="bar-detail">
                            (✅ ${tech.usedCount} • 💬 ${tech.mentionedCount})
                        </span>
                    </div>
                </div>
                `
                  )
                  .join('')}
            </div>
        </div>

        <!-- Top Keywords -->
        <div class="section">
            <h2>💡 Concepts clés par fréquence</h2>
            <div class="bar-chart">
                ${top15Keywords
                  .map(
                    (kw) => `
                <div class="bar-item">
                    <div class="bar-label">${kw.keyword}</div>
                    <div class="bar">${generateBar(kw.count, maxKeywordCount)}</div>
                    <div class="bar-count">${kw.count} leçons</div>
                </div>
                `
                  )
                  .join('')}
            </div>
        </div>

        <!-- Progression chronologique -->
        <div class="section">
            <h2>📚 Progression chronologique</h2>
            ${graph.chapters
              .map(
                (chapter) => `
            <div class="chapter-block">
                <div class="chapter-header">
                    ${chapter.title}
                </div>
                <div class="chapter-meta">
                    <div class="chapter-meta-item">
                        <strong>${chapter.lessonCount}</strong> leçons
                    </div>
                    <div class="chapter-meta-item">
                        <strong>${chapter.allTechnologies.length}</strong> technologies
                    </div>
                    <div class="chapter-meta-item">
                        <strong>${chapter.keywordCount}</strong> concepts
                    </div>
                </div>

                ${(() => {
                  // Count and filter technologies used with threshold
                  const usedCounts = countFromLessons(chapter.lessons, 'technologiesUsed');
                  const usedFiltered = filterAndSortWithCounts(usedCounts, 2);

                  if (usedFiltered.length === 0) return '';

                  return `
                <div style="margin: 15px 0;">
                    <strong>✅ Technologies pratiquées (${usedFiltered.length} / min 2 leçons):</strong>
                    <div class="tech-list">
                        ${usedFiltered.map(({name, count}) => `<span class="badge badge-new" title="${count} leçons">${name} (${count})</span>`).join('')}
                    </div>
                </div>
                  `;
                })()}

                ${(() => {
                  // Count and filter technologies mentioned with threshold
                  const mentionedCounts = countFromLessons(chapter.lessons, 'technologiesMentioned');
                  // Filter out those that are also used
                  const usedCounts = countFromLessons(chapter.lessons, 'technologiesUsed');
                  const mentionedOnlyCounts = new Map<string, number>();
                  mentionedCounts.forEach((count, name) => {
                    if (!usedCounts.has(name)) {
                      mentionedOnlyCounts.set(name, count);
                    }
                  });
                  const mentionedFiltered = filterAndSortWithCounts(mentionedOnlyCounts, 2);

                  if (mentionedFiltered.length === 0) return '';

                  return `
                <div style="margin: 15px 0;">
                    <strong>💬 Technologies mentionnées (${mentionedFiltered.length} / min 2 leçons):</strong>
                    <div class="tech-list">
                        ${mentionedFiltered.map(({name, count}) => `<span class="badge badge-reused" title="${count} leçons">${name} (${count})</span>`).join('')}
                    </div>
                </div>
                  `;
                })()}

                ${(() => {
                  // Count and filter keywords with threshold
                  const keywordCounts = countFromLessons(chapter.lessons, 'keywords');
                  const keywordFiltered = filterAndSortWithCounts(keywordCounts, 2, 15);

                  if (keywordFiltered.length === 0) return '';

                  return `
                <div style="margin: 15px 0;">
                    <strong>💡 Concepts (${keywordFiltered.length} / min 2 leçons, top 15):</strong>
                    <div class="keyword-list">
                        ${keywordFiltered.map(({name, count}) => `<span class="badge badge-concept" title="${count} leçons">${name} (${count})</span>`).join('')}
                    </div>
                </div>
                  `;
                })()}
            </div>
            `
              )
              .join('')}
        </div>

        <!-- Matrice technologique -->
        ${matrixHTML}

        <div class="footer">
            <p>Généré le ${new Date(graph.generatedAt).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
            <p>Outil: scraper-formation</p>
        </div>
    </div>
</body>
</html>`;
}

/**
 * Generate technology matrix HTML section
 */
function generateTechnologyMatrixHTML(graph: PedagogicalGraph): string {
  const { technologies, chapters } = graph.technologyMatrix;

  // Find max usage across all technologies
  const maxUsage = Math.max(
    ...chapters.flatMap((ch) => ch.usage),
    1
  );

  // Set minimum threshold: 3 lessons minimum
  const threshold = 3;

  // Filter technologies that meet the threshold in at least one chapter
  const filteredTechs = technologies.filter((tech, techIdx) => {
    const maxUsageForTech = Math.max(...chapters.map((ch) => ch.usage[techIdx] || 0));
    return maxUsageForTech >= threshold;
  });

  // Limit to top 40 technologies for readability
  const topTechs = filteredTechs.slice(0, 40);

  // Generate intensity class (0-9)
  const getIntensityClass = (count: number): string => {
    if (count === 0) return 'intensity-0';
    const intensity = Math.min(9, Math.ceil((count / maxUsage) * 9));
    return `intensity-${intensity}`;
  };

  return `
    <div class="section">
        <h2>🎓 Matrice technologique</h2>
        <p style="margin-bottom: 15px; color: #7f8c8d;">
            Technologies principales par chapitre (seuil: ${threshold}+ leçons, affichant ${topTechs.length}/${filteredTechs.length} technologies)
        </p>
        <div class="matrix">
            <table>
                <thead>
                    <tr>
                        <th class="tech-name">Technologie</th>
                        ${chapters.map((ch, idx) => `<th>Ch.${idx + 1}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${topTechs
                      .map(
                        (tech) => {
                          // Find original index of this technology
                          const originalIdx = technologies.indexOf(tech);
                          return `
                    <tr>
                        <th class="tech-name">${tech}</th>
                        ${chapters
                          .map((ch) => {
                            const count = ch.usage[originalIdx] || 0;
                            return `<td class="${getIntensityClass(count)}">${count > 0 ? count : '–'}</td>`;
                          })
                          .join('')}
                    </tr>
                    `;
                        }
                      )
                      .join('')}
                </tbody>
            </table>
        </div>
        <p style="margin-top: 10px; color: #7f8c8d; font-size: 0.85em;">
            💡 Seules les technologies avec au moins ${threshold} leçons dans un chapitre sont affichées (maximum ${topTechs.length}). Les cellules colorées indiquent le nombre de leçons.
        </p>
    </div>
  `;
}

/**
 * Generate Markdown template for knowledge graph
 */
export function generateMarkdownTemplate(graph: PedagogicalGraph): string {
  const maxBarLength = 30;

  const generateBar = (count: number, maxCount: number): string => {
    const barLength = Math.round((count / maxCount) * maxBarLength);
    return '█'.repeat(barLength);
  };

  // Helper: Count frequencies from lessons and filter/sort with threshold (same as HTML)
  const countFromLessons = (lessons: any[], field: string): Map<string, number> => {
    const counts = new Map<string, number>();
    lessons.forEach(lesson => {
      const items = lesson[field] || [];
      items.forEach((item: string) => {
        counts.set(item, (counts.get(item) || 0) + 1);
      });
    });
    return counts;
  };

  const filterAndSortWithCounts = (counts: Map<string, number>, threshold: number = 2, limit?: number): Array<{name: string, count: number}> => {
    const items = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .filter(item => item.count >= threshold)
      .sort((a, b) => b.count - a.count);

    return limit ? items.slice(0, limit) : items;
  };

  const top15Techs = graph.topTechnologies.slice(0, 15);
  const maxTechCount = top15Techs[0]?.count || 1;

  const top15Keywords = graph.topKeywords.slice(0, 15);
  const maxKeywordCount = top15Keywords[0]?.count || 1;

  return `# 📊 ${graph.courseTitle} - Cartographie Pédagogique

**${graph.totalLessons} leçons** • **${graph.totalChapters} chapitres** • Généré le ${new Date(graph.generatedAt).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}

---

## 🎯 Vue d'ensemble

| Métrique | Valeur |
|----------|--------|
| **Total leçons** | ${graph.totalLessons} |
| **Total chapitres** | ${graph.totalChapters} |
| **Total technologies** | ${graph.statistics.totalTechnologies} |
| **Total concepts** | ${graph.statistics.totalKeywords} |
| **Techno / Leçon** | ${graph.statistics.avgTechnologiesPerLesson.toFixed(1)} |
| **Concepts / Leçon** | ${graph.statistics.avgKeywordsPerLesson.toFixed(1)} |

---

## 🔥 Technologies par fréquence

| # | Technologie | ✅ Utilisée | 💬 Mentionnée | Total | Intro |
|---|-------------|-------------|---------------|-------|-------|
${top15Techs
  .map((tech, idx) => {
    const chapterIdx = graph.chapters.findIndex((ch) => ch.number === tech.firstAppearance.chapterNumber);
    const displayChapterNumber = chapterIdx !== -1 ? chapterIdx + 1 : tech.firstAppearance.chapterNumber;
    return `| ${idx + 1} | **${tech.name}** | ${tech.usedCount} | ${tech.mentionedCount} | **${tech.count}** | Ch.${displayChapterNumber} |`;
  })
  .join('\n')}

---

## 💡 Concepts clés par fréquence

${top15Keywords
  .map((kw) => {
    const bar = generateBar(kw.count, maxKeywordCount);
    return `**${kw.keyword}**
${bar} ${kw.count} leçons`;
  })
  .join('\n\n')}

---

## 📚 Progression chronologique

${graph.chapters
  .map(
    (chapter) => `
### ${chapter.title}

**${chapter.lessonCount} leçons**

${(() => {
  const usedCounts = countFromLessons(chapter.lessons, 'technologiesUsed');
  const usedFiltered = filterAndSortWithCounts(usedCounts, 2);

  if (usedFiltered.length === 0) return '';

  return `**✅ Technologies pratiquées (${usedFiltered.length} / min 2 leçons):**
${usedFiltered.map(({name, count}) => `\`${name} (${count})\``).join(', ')}
`;
})()}
${(() => {
  const mentionedCounts = countFromLessons(chapter.lessons, 'technologiesMentioned');
  const usedCounts = countFromLessons(chapter.lessons, 'technologiesUsed');
  const mentionedOnlyCounts = new Map<string, number>();
  mentionedCounts.forEach((count, name) => {
    if (!usedCounts.has(name)) {
      mentionedOnlyCounts.set(name, count);
    }
  });
  const mentionedFiltered = filterAndSortWithCounts(mentionedOnlyCounts, 2);

  if (mentionedFiltered.length === 0) return '';

  return `**💬 Technologies mentionnées (${mentionedFiltered.length} / min 2 leçons):**
${mentionedFiltered.map(({name, count}) => `\`${name} (${count})\``).join(', ')}
`;
})()}
${(() => {
  const keywordCounts = countFromLessons(chapter.lessons, 'keywords');
  const keywordFiltered = filterAndSortWithCounts(keywordCounts, 2, 15);

  if (keywordFiltered.length === 0) return '';

  return `**💡 Concepts (${keywordFiltered.length} / min 2 leçons, top 15):**
${keywordFiltered.map(({name, count}) => `\`${name} (${count})\``).join(', ')}
`;
})()}
`
  )
  .join('\n---\n')}

---

## 🎓 Matrice technologique

| Technologie | ${graph.chapters.map((ch, idx) => `Ch.${idx + 1}`).join(' | ')} |
|-------------|${graph.chapters.map(() => '---').join('|')}|
${(() => {
  const { technologies, chapters } = graph.technologyMatrix;
  const threshold = 3;
  const filteredTechs = technologies.filter((tech, techIdx) => {
    const maxUsageForTech = Math.max(...chapters.map((ch) => ch.usage[techIdx] || 0));
    return maxUsageForTech >= threshold;
  });
  const topTechs = filteredTechs.slice(0, 40);
  return topTechs
    .map((tech) => {
      const originalIdx = technologies.indexOf(tech);
      const row = chapters
        .map((ch) => {
          const count = ch.usage[originalIdx] || 0;
          return count > 0 ? `**${count}**` : '–';
        })
        .join(' | ');
      return `| ${tech} | ${row} |`;
    })
    .join('\n');
})()}

_Seules les technologies avec au moins 3 leçons dans un chapitre sont affichées (maximum 40)._

---

**Généré avec:** scraper-formation
**Date:** ${new Date(graph.generatedAt).toISOString()}
`;
}
