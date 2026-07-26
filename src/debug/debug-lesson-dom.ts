/**
 * Debug script to inspect lesson page DOM structure
 */

import 'dotenv/config';
import { authenticate } from '../auth.js';
import { createLogger } from '../utils.js';

const logger = createLogger('debug-lesson-dom');

async function main() {
  try {
    const lessonId = process.argv[2] || '1021159';

    const email = process.env.FORMATION_EMAIL;
    const password = process.env.FORMATION_PASSWORD;
    const formationUrl = process.env.FORMATION_URL;

    if (!email || !password) {
      throw new Error('FORMATION_EMAIL and FORMATION_PASSWORD must be set in .env');
    }
    if (!formationUrl) {
      throw new Error('FORMATION_URL must be set in .env');
    }

    logger.info({ lessonId }, 'Inspecting lesson DOM structure');

    // Authenticate
    logger.info('Authenticating...');
    const mcpClient = await authenticate({ email, password }, formationUrl);

    // Navigate to lesson
    const url = `${formationUrl}/elements/${lessonId}`;
    logger.info({ url }, 'Navigating to lesson...');
    await mcpClient.navigate(url);

    // Wait for page load
    logger.info('Waiting for page load...');
    await mcpClient.waitFor({ timeout: 5000 });

    logger.info('🔍 Inspecting DOM structure...\n');

    // Debug 1: Check h1 title
    const h1Text = await mcpClient.evaluate(`
      document.querySelector('h1')?.textContent?.trim() || 'NOT FOUND'
    `);
    logger.info({ h1Text }, '1. Page title (h1)');

    // Debug 2: Check all main container candidates
    const containers = await mcpClient.evaluate(`
      (() => {
        const candidates = [
          { selector: '.lesson-content', exists: !!document.querySelector('.lesson-content') },
          { selector: 'main article', exists: !!document.querySelector('main article') },
          { selector: 'main section', exists: !!document.querySelector('main section') },
          { selector: '[class*="content"]', exists: !!document.querySelector('[class*="content"]') },
          { selector: 'main .container', exists: !!document.querySelector('main .container') },
          { selector: 'main', exists: !!document.querySelector('main') },
        ];
        return candidates;
      })()
    `);
    logger.info('2. Container candidates:');
    containers.forEach((c: any) => logger.info(`   ${c.selector}: ${c.exists ? '✅ EXISTS' : '❌ NOT FOUND'}`));

    // Debug 3: Count paragraphs in different containers
    const paragraphCounts = await mcpClient.evaluate(`
      (() => {
        return {
          'document': document.querySelectorAll('p').length,
          'main': document.querySelector('main')?.querySelectorAll('p').length || 0,
          'main article': document.querySelector('main article')?.querySelectorAll('p').length || 0,
          'main section': document.querySelector('main section')?.querySelectorAll('p').length || 0,
        };
      })()
    `);
    logger.info('3. Paragraph counts by container:');
    Object.entries(paragraphCounts).forEach(([key, count]) => logger.info(`   ${key}: ${count} paragraphs`));

    // Debug 4: Get all paragraph text (first 3)
    const paragraphTexts = await mcpClient.evaluate(`
      (() => {
        const paragraphs = Array.from(document.querySelectorAll('p'));
        return paragraphs.slice(0, 3).map(p => p.textContent?.trim()?.substring(0, 100));
      })()
    `);
    logger.info('4. First 3 paragraphs:');
    paragraphTexts.forEach((text: any, idx: number) => logger.info(`   ${idx + 1}. ${text}...`));

    // Debug 5: Check for iframes (YouTube/Vimeo)
    const iframes = await mcpClient.evaluate(`
      (() => {
        const allIframes = Array.from(document.querySelectorAll('iframe'));
        return allIframes.map(iframe => ({
          src: iframe.getAttribute('src'),
          width: iframe.getAttribute('width'),
          height: iframe.getAttribute('height'),
        }));
      })()
    `);
    logger.info({ count: iframes.length }, '5. Iframes found');
    iframes.forEach((iframe: any, idx: number) => {
      logger.info(`   ${idx + 1}. ${iframe.src}`);
    });

    // Debug 6: Get main element's HTML structure (first 500 chars)
    const mainHtml = await mcpClient.evaluate(`
      (() => {
        const main = document.querySelector('main');
        if (!main) return 'MAIN NOT FOUND';

        // Get structure without full content
        const structure = [];
        for (const child of main.children) {
          structure.push({
            tag: child.tagName,
            classes: child.className,
            id: child.id,
            childCount: child.children.length,
          });
        }
        return structure;
      })()
    `);
    logger.info('6. Main element structure:');
    if (typeof mainHtml === 'string') {
      logger.info(mainHtml);
    } else {
      mainHtml.forEach((el: any, idx: number) => {
        logger.info(`   ${idx + 1}. <${el.tag}> class="${el.classes}" id="${el.id}" (${el.childCount} children)`);
      });
    }

    // Debug 7: Try to find content using different strategies
    const contentTests = await mcpClient.evaluate(`
      (() => {
        const tests = [];

        // Strategy 1: Find the div that contains both h1 and paragraphs
        const h1 = document.querySelector('h1');
        if (h1) {
          let parent = h1.parentElement;
          let level = 0;
          while (parent && level < 5) {
            const paragraphs = parent.querySelectorAll('p').length;
            tests.push({
              strategy: 'h1-parent-' + level,
              selector: parent.tagName + (parent.className ? '.' + parent.className.split(' ')[0] : ''),
              paragraphs: paragraphs,
            });
            parent = parent.parentElement;
            level++;
          }
        }

        // Strategy 2: Find largest div with paragraphs
        const allDivs = Array.from(document.querySelectorAll('div'));
        const divsByContent = allDivs
          .map(div => ({
            div: div,
            paragraphs: div.querySelectorAll('p').length,
            text: div.textContent?.length || 0,
          }))
          .sort((a, b) => b.text - a.text)
          .slice(0, 3);

        divsByContent.forEach((item, idx) => {
          const div = item.div;
          tests.push({
            strategy: 'largest-div-' + idx,
            selector: div.tagName + (div.className ? '.' + div.className.split(' ')[0] : '') + (div.id ? '#' + div.id : ''),
            paragraphs: item.paragraphs,
            textLength: item.text,
          });
        });

        return tests;
      })()
    `);
    logger.info('7. Content location strategies:');
    contentTests.forEach((test: any) => {
      logger.info(`   ${test.strategy}: ${test.selector} - ${test.paragraphs} paragraphs, ${test.textLength || 0} chars`);
    });

    // Debug 8: Check for navigation buttons (might be interfering)
    const navButtons = await mcpClient.evaluate(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons
          .filter(btn => btn.textContent?.includes('Précédent') || btn.textContent?.includes('Suivant'))
          .map(btn => ({
            text: btn.textContent?.trim(),
            parent: btn.parentElement?.tagName,
          }));
      })()
    `);
    logger.info('8. Navigation buttons:');
    navButtons.forEach((btn: any) => {
      logger.info(`   "${btn.text}" (in ${btn.parent})`);
    });

    await mcpClient.disconnect();
    logger.info('\n✅ DOM inspection complete');
  } catch (error) {
    logger.error({ error }, '❌ Inspection failed');
    process.exit(1);
  }
}

main();
