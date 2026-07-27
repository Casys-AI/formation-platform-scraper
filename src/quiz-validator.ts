/**
 * Quiz Validator - Automatically complete quizzes/QCMs to unlock subsequent lessons
 *
 * Problem: When skipQuizzes is enabled, we skip quiz extraction but the platform
 * requires quiz completion to unlock the next lessons. Simply marking as complete
 * doesn't work - we need to actually answer the questions and submit.
 *
 * Solution: Use Playwright to:
 * 1. Navigate to quiz URL
 * 2. Click "Commencer le quiz" or "Commencer le QCM" button
 * 3. Select the first answer for each question (radio buttons)
 * 4. Click "Envoyer mes réponses" to submit
 *
 * This unlocks the subsequent lessons so they can be extracted properly.
 *
 * Note: Some formations use "Quiz" while others use "QCM" (Questionnaire à Choix Multiples).
 * Both are supported.
 */

import { createLogger } from './utils.js';

const logger = createLogger('quiz-validator');

interface QuizValidationResult {
  success: boolean;
  questionCount: number;
  error?: string;
}

/**
 * Automatically complete a quiz by selecting first answer for each question
 *
 * @param browser - browser automation (Playwright)
 * @param quizUrl - Full URL to the quiz page
 * @returns Result indicating success and question count
 */
export async function autoCompleteQuiz(
  browser: any,
  quizUrl: string
): Promise<QuizValidationResult> {
  try {
    logger.info({ quizUrl }, '🎯 Starting automatic quiz completion');

    // 1. Navigate to quiz page
    logger.debug('Navigating to quiz page...');
    await browser.navigate(quizUrl);

    // Wait for page to fully load (same as normal lessons)
    await sleep(5000);

    // 2. Check if quiz is already completed using DOM query (not snapshot)
    logger.debug('Checking if quiz already completed...');
    const isCompleted = await browser.evaluate(`() => {
      const bodyText = document.body.innerText;
      return bodyText.includes('Quiz complété le') || bodyText.includes('QCM complété le');
    }`);

    if (isCompleted) {
      logger.info({ quizUrl }, '🎯 Quiz/QCM already completed - skipping');
      return { success: true, questionCount: 0 };
    }

    // 3. Find and click start button using DOM query (same approach as lesson extraction)
    logger.debug('Looking for quiz start button in DOM...');
    const startButtonClicked = await browser.evaluate(`() => {
      // Look for button with text containing "Quiz" or "QCM" or "Commencer"
      const buttons = Array.from(document.querySelectorAll('button'));
      const startButton = buttons.find(btn => {
        const text = btn.innerText.toLowerCase();
        return text.includes('quiz') || text.includes('qcm') || text.includes('commencer');
      });

      if (startButton) {
        startButton.click();
        return true;
      }
      return false;
    }`);

    if (startButtonClicked) {
      logger.debug('Start button clicked, waiting for quiz to load...');
      await sleep(5000); // Increased to 5s - quiz may take time to load questions
    } else {
      logger.debug('No start button found - quiz may already be started');
    }

    // 4. Wait for questions to appear with polling (max 10 seconds)
    logger.debug('Waiting for quiz questions to appear...');
    let questionsFound = false;
    for (let i = 0; i < 5; i++) {
      const hasQuestions = await browser.evaluate(`() => {
        const articles = document.querySelectorAll('article');
        const radios = document.querySelectorAll('input[type="radio"]');
        return articles.length > 0 && radios.length > 0;
      }`);

      if (hasQuestions) {
        questionsFound = true;
        logger.debug({ attempts: i + 1 }, 'Quiz questions found');
        break;
      }

      logger.debug({ attempt: i + 1 }, 'Questions not yet loaded, waiting...');
      await sleep(2000);
    }

    if (!questionsFound) {
      const errorMsg = 'Quiz questions did not appear after waiting';
      logger.error({ quizUrl }, errorMsg);
      return {
        success: false,
        questionCount: 0,
        error: errorMsg
      };
    }

    // 5. Select first answer for each question using JavaScript
    logger.debug('Selecting first answer for each question...');

    const questionCount = await browser.evaluate(`() => {
      // Find all articles (each article is a question)
      const questions = document.querySelectorAll('article');
      let selectedCount = 0;

      questions.forEach(article => {
        // Find the first radio button in this question
        const firstRadio = article.querySelector('input[type="radio"]');
        if (firstRadio && !firstRadio.checked) {
          // Try clicking parent label first (works with custom styled radio buttons)
          const label = firstRadio.closest('label');
          if (label) {
            label.click();
          } else {
            // Fallback: try clicking the parent container or the radio itself
            const parent = firstRadio.parentElement;
            if (parent && parent.tagName !== 'ARTICLE') {
              parent.click();
            } else {
              firstRadio.click();
            }
          }
          selectedCount++;
        }
      });

      return selectedCount;
    }`);

    logger.debug({ questionCount }, 'Evaluated script result');

    // Validate that questions were found and answered
    if (!questionCount || questionCount === 0) {
      const errorMsg = 'No quiz questions found on page - quiz may not have loaded properly';
      logger.error({ quizUrl, questionCount }, errorMsg);
      return {
        success: false,
        questionCount: 0,
        error: errorMsg
      };
    }

    logger.info({ questionCount }, `✅ Selected ${questionCount} answers`);
    await sleep(1000);

    // 5. Submit quiz answers using DOM query
    logger.debug('Submitting quiz answers...');

    const submitClicked = await browser.evaluate(`() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const submitButton = buttons.find(btn =>
        btn.innerText.includes('Envoyer') || btn.innerText.includes('Valider')
      );

      if (submitButton) {
        submitButton.click();
        return true;
      }
      return false;
    }`);

    if (submitClicked) {
      logger.debug('Submit button clicked, waiting for confirmation...');
      await sleep(2000);

      // 6. Confirm submission (click "Ok !" button)
      logger.debug('Confirming submission...');
      const confirmClicked = await browser.evaluate(`() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const confirmButton = buttons.find(btn =>
          btn.innerText.includes('Ok') || btn.innerText.includes('Continuer')
        );

        if (confirmButton) {
          confirmButton.click();
          return true;
        }
        return false;
      }`);

      if (confirmClicked) {
        logger.debug('Confirmation clicked');
        await sleep(2000);
      }
    }

    logger.info({ questionCount }, '✅ Quiz completed successfully');

    return {
      success: true,
      questionCount
    };

  } catch (error) {
    logger.error({ error, quizUrl }, '❌ Failed to complete quiz');
    return {
      success: false,
      questionCount: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Count number of questions in the quiz from snapshot content
 */
function countQuestions(snapshotContent: string): number {
  // Count articles with heading level 3 (each question is an article with h3)
  const articleMatches = snapshotContent.match(/article.*?heading.*?\[level=3\]/g);
  return articleMatches ? articleMatches.length : 0;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
