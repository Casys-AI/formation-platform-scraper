/**
 * Lesson completion detection and marking
 *
 * Some formations require marking lessons as "completed" before allowing access to the next lesson.
 * This module provides auto-detection and marking functionality.
 */

import type { Browser } from './browser.js';
import { createLogger } from './utils.js';

const logger = createLogger('lesson-completion');

/**
 * Mark a lesson as complete by clicking the completion button and confirming
 */
export async function markLessonComplete(
  browser: Browser,
  lessonUrl: string,
  waitAfterConfirm: number = 2000
): Promise<boolean> {
  try {
    logger.info({ lessonUrl }, '🔘 Marking lesson as complete');

    // Navigate to the lesson
    await browser.navigate(lessonUrl);
    await browser.waitFor({ timeout: 2000 }); // Wait for page to settle

    // CSS Selectors verified on 2025-11-08 on a Teachizy formation
    // Completion button: <button class="button is-medium is-primary is-custom">
    // Confirmation button: <button class="button is-danger">

    // Click the "J'ai terminé cette leçon" button
    logger.debug({ lessonUrl }, 'Clicking "J\'ai terminé cette leçon" button');
    await browser.click('button.is-primary.is-custom');

    // Wait for popup to appear
    await browser.waitFor({ timeout: 1000 });

    // Click the "Confirmer" button in popup
    logger.debug({ lessonUrl }, 'Clicking "Confirmer" button');
    await browser.click('button.is-danger');

    // Wait for confirmation to process
    await new Promise(resolve => setTimeout(resolve, waitAfterConfirm));

    logger.info({ lessonUrl }, '✅ Lesson marked as complete');
    return true;
  } catch (error) {
    logger.error({ lessonUrl, error }, '❌ Failed to mark lesson as complete');
    return false;
  }
}

/**
 * Try to access a lesson and check if it's accessible
 */
export async function tryAccessLesson(
  browser: Browser,
  lessonUrl: string
): Promise<boolean> {
  try {
    logger.debug({ lessonUrl }, 'Trying to access lesson');

    await browser.navigate(lessonUrl);
    await browser.waitFor({ timeout: 2000 }); // Wait for page to settle

    // Take snapshot to check if we can see the lesson content
    const snapshot = await browser.snapshot();

    // Check for blocking messages (verified from actual tenant formation pages on 2025-11-10)
    // Two types of blocking messages:
    // 1. "Vous devez finir toutes les leçons précédentes avant d'accéder à celle-ci"
    // 2. "Cette action ne vous est pas autorisée" + "Retour à l'accueil"
    const hasBlockingMessage = snapshot.includes('Vous devez finir') ||
                              snapshot.includes('avant d\'accéder à celle-ci') ||
                              snapshot.includes('Cette action') ||
                              snapshot.includes('pas autorisée') ||
                              (snapshot.includes('Retour') && snapshot.includes('accueil'));

    // Heuristic: Real lesson content should have substantial text
    // Blocking pages are typically very short (< 500 chars in snapshot)
    const hasSubstantialContent = snapshot.length > 1000; // Increased threshold

    // Accessible if: has content AND no blocking message
    const accessible = hasSubstantialContent && !hasBlockingMessage;

    logger.info(
      {
        lessonUrl,
        accessible,
        snapshotLength: snapshot.length,
        hasBlockingMessage,
        snapshotPreview: snapshot.substring(0, 200) // First 200 chars for debugging
      },
      accessible ? '✅ Lesson accessible' : '❌ Lesson blocked'
    );
    return accessible;
  } catch (error) {
    logger.error({ lessonUrl, error }, '❌ Failed to check lesson accessibility');
    return false;
  }
}

/**
 * Check if a lesson is already marked as complete on the platform
 *
 * Detects completion by looking for the completion indicator:
 * "Leçon terminée le [date]" text that appears at the bottom of completed lessons
 */
export async function isLessonAlreadyComplete(
  browser: Browser,
  lessonUrl: string
): Promise<boolean> {
  try {
    logger.debug({ lessonUrl }, 'Checking if lesson is already marked as complete');

    // Navigate to the lesson
    await browser.navigate(lessonUrl);
    await browser.waitFor({ timeout: 2000 }); // Wait for page to settle

    // Take snapshot to check for completion indicator
    const snapshot = await browser.snapshot();

    // Check for completion indicator text
    // Verified pattern from actual tenant formation pages on 2025-11-10:
    // "Leçon terminée le 10/11/25" or similar date formats
    const hasCompletionIndicator = snapshot.includes('Leçon terminée le') ||
                                   snapshot.includes('Leçon terminée');

    logger.debug(
      {
        lessonUrl,
        isComplete: hasCompletionIndicator,
        snapshotLength: snapshot.length
      },
      hasCompletionIndicator ? '✅ Lesson already marked as complete' : '⏳ Lesson not yet marked as complete'
    );

    return hasCompletionIndicator;
  } catch (error) {
    logger.error({ lessonUrl, error }, '❌ Failed to check lesson completion status');
    // If we can't check, assume not complete to be safe
    return false;
  }
}

/**
 * Detect if a formation requires marking lessons as complete
 *
 * Detection process:
 * 1. Try to access the next lesson
 * 2. If blocked, go back to current lesson and mark it complete
 * 3. Try to access the next lesson again
 * 4. If now accessible → detection success (requires completion)
 * 5. If still blocked → detection failure (doesn't require completion, or other issue)
 */
export async function detectCompletionRequirement(
  browser: Browser,
  currentLessonUrl: string,
  nextLessonUrl: string,
  waitAfterConfirm: number = 2000
): Promise<boolean> {
  logger.info('🔍 Detecting if formation requires lesson completion marking');

  // Step 1: Try to access next lesson without marking current as complete
  const initiallyAccessible = await tryAccessLesson(browser, nextLessonUrl);

  if (initiallyAccessible) {
    logger.info('✅ Next lesson accessible without marking - completion NOT required');
    return false;
  }

  logger.info('⚠️ Next lesson blocked - testing if marking current lesson helps');

  // Step 2: Mark current lesson as complete
  const marked = await markLessonComplete(browser, currentLessonUrl, waitAfterConfirm);

  if (!marked) {
    logger.warn('⚠️ Failed to mark lesson as complete - assuming completion NOT required');
    return false;
  }

  // Step 3: Try to access next lesson again after marking
  const accessibleAfterMarking = await tryAccessLesson(browser, nextLessonUrl);

  if (accessibleAfterMarking) {
    logger.info('✅ Marking lesson unlocked next lesson - completion IS required for this formation');
    return true;
  } else {
    logger.warn('❌ Marking did not unlock next lesson - completion NOT required (or other blocking issue)');
    return false;
  }
}
