# ADR-003: Quiz Pagination Not Supported

**Date:** 2025-11-11
**Status:** ✅ Accepted
**Context:** Quiz auto-completion implementation

---

## Problem

Some quiz formats may require pagination (clicking "Suivante" or "Next" button) to navigate between questions, rather than displaying all questions on a single page.

---

## Decision

**We do NOT support quiz pagination** in the current implementation.

The quiz auto-completion logic in `quiz-validator.ts` assumes all questions are visible on the page at once after clicking "Commencer le quiz/QCM":

```typescript
const questionCount = await mcpClient.evaluate(`() => {
  // Find ALL articles (each article is a question)
  const questions = document.querySelectorAll('article'); // ← Selects ALL visible questions
  let selectedCount = 0;

  questions.forEach(article => {
    const firstRadio = article.querySelector('input[type="radio"]');
    if (firstRadio && !firstRadio.checked) {
      firstRadio.click();
      selectedCount++;
    }
  });

  return selectedCount;
}`);
```

---

## Supported Format

**✅ Single-page quiz format** (the tenant platform):
- All questions displayed at once after clicking "Commencer le quiz"
- Each question is an `<article>` element with radio buttons
- No pagination between questions
- Example: Quiz with 5 questions → all 5 visible simultaneously

---

## NOT Supported

**❌ Multi-page quizzes:**
- Quizzes requiring navigation with "Suivante" (Next) button
- One question per page format
- Dynamic question loading (AJAX pagination)
- Quizzes with "Précédente" (Previous) navigation

---

## Rationale

### Why This Decision Was Made

1. **Current Platform Behavior**: the tenant platform displays all quiz questions on a single page after clicking start button
2. **Implementation Complexity**: Pagination would require:
   - Detecting "Suivante" button
   - Loop through pages
   - Track current question index
   - Handle edge cases (last question, no next button)
   - Estimated time: +2-3 hours
3. **ROI (Return on Investment)**:
   - Quiz auto-completion is already pragmatic (not extracting content)
   - Purpose is to unlock subsequent lessons, not provide perfect quiz UX
   - Single-page format works for current use case
4. **YAGNI Principle**: "You Ain't Gonna Need It"
   - No pagination encountered in testing
   - Defer implementation until clear need emerges

---

## Consequences

### ✅ Benefits
- **Simpler implementation**: 50 lines vs 150+ with pagination
- **Faster execution**: Single evaluate() call vs multiple page navigations
- **Lower maintenance**: Fewer edge cases and failure modes
- **Sufficient for current needs**: Works with the tenant platform format

### ⚠️ Limitations
- **Will fail on paginated quizzes**: If platform changes to one-question-per-page format
- **Manual intervention required**: User must complete paginated quizzes manually
- **Potential lesson locking**: Subsequent lessons may remain locked if paginated quiz fails

---

## Future Implementation (If Needed)

If quiz pagination becomes necessary, implement as **Story 5.1.2: Quiz Pagination Support**.

### Detection Logic
```typescript
// After selecting answers for visible questions
const hasNextButton = await mcpClient.evaluate(`() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  return buttons.some(btn =>
    btn.innerText.toLowerCase().includes('suivante') ||
    btn.innerText.toLowerCase().includes('next')
  );
}`);

if (hasNextButton) {
  // Handle pagination...
}
```

### Pagination Loop
```typescript
let currentPage = 1;
let totalQuestionsAnswered = 0;

while (true) {
  // 1. Answer questions on current page
  const questionsOnPage = await answerVisibleQuestions(mcpClient);
  totalQuestionsAnswered += questionsOnPage;

  // 2. Check for "Suivante" button
  const nextClicked = await mcpClient.evaluate(`() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const nextButton = buttons.find(btn =>
      btn.innerText.toLowerCase().includes('suivante') ||
      btn.innerText.toLowerCase().includes('next')
    );

    if (nextButton && !nextButton.disabled) {
      nextButton.click();
      return true;
    }
    return false;
  }`);

  if (!nextClicked) {
    break; // No more pages
  }

  // 3. Wait for next page to load
  await sleep(2000);
  currentPage++;

  // Safety: max 20 pages
  if (currentPage > 20) {
    throw new Error('Too many quiz pages (>20) - possible infinite loop');
  }
}
```

### Estimated Complexity
- **Time**: 2-3 hours
- **Lines of code**: +100 lines
- **Risk**: Medium (more failure modes, timeout handling)

---

## Related Files

- [quiz-validator.ts](../../src/quiz-validator.ts) - Current single-page implementation

---

## Reversal Conditions

This decision should be reconsidered if:

1. **Platform changes format**: the tenant platform switches to paginated quizzes
2. **User encounters failures**: Multiple quizzes fail due to pagination
3. **Automated testing reveals issue**: >10% of quizzes require pagination
4. **Business requirement emerges**: Content extraction needs paginated quiz data

---

## Approval

**Decided by:** Dev Team
**Documented by:** Claude
**Status:** Accepted - will not implement unless clear need emerges

---

**Next Review Date:** When first paginated quiz is encountered in production