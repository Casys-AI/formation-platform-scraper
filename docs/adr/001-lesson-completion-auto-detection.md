# ADR 001: Lesson Completion Auto-Detection

## Status
Accepted

## Context

Some formations on the tenant platform require explicitly marking a lesson as "completed" (clicking "J'ai terminé cette leçon" button + confirming in a popup) before allowing access to the next lesson. This behavior is:

1. **Variable by formation**: Some formations require this (e.g., Example Program), others don't
2. **Not predictable upfront**: Cannot determine from formation metadata whether completion marking is required
3. **Always present**: The completion button exists on all lessons, but sometimes it's mandatory to click it, sometimes it's optional

**Example blocking scenario:**
- Extract lesson 1 successfully
- Try to access lesson 2
- Platform blocks access until lesson 1 is marked as "completed"

**Button elements:**
```html
<!-- Completion button -->
<button data-v-6aae1842="" type="button" class="button is-medium is-primary is-custom">
  J'ai terminé cette leçon
</button>

<!-- Confirmation popup button -->
<button type="button" class="button is-danger">
  Confirmer
</button>
```

## Decision

Implement **adaptive auto-detection** with the following logic:

### 1. Initial State
- Start with `requiresCompletion = false`
- No assumptions about the formation's behavior

### 2. Detection Trigger
- When attempting to extract lesson N and access appears blocked (or after extracting each lesson as a proactive check)
- Trigger detection only once per extraction run

### 3. Detection Process
1. Navigate back to lesson N-1 (previously extracted lesson)
2. Click "J'ai terminé cette leçon" button
3. Click "Confirmer" button in confirmation popup
4. Wait for configurable delay (default: 2000ms)
5. Try to access lesson N again

**If successful (lesson N now accessible):**
- Set `requiresCompletion = true`
- Apply completion marking to **ALL remaining lessons** in the extraction run

**If still blocked (lesson N still inaccessible):**
- Set `requiresCompletion = false`
- Abandon the completion marking feature
- Continue extraction without marking (may fail if formation truly requires it)

### 4. Configuration
Add simple opt-in/opt-out configuration:

```typescript
lessonCompletion?: {
  autoDetect: boolean;        // Default: true
  waitAfterConfirm?: number;  // Default: 2000ms
};
```

### 5. Implementation Principles
- **One-time learning**: Detection happens once, then behavior persists for entire run
- **Graceful fallback**: If marking doesn't help, abandon gracefully
- **Minimal overhead**: Only retry once when blocked
- **Configurable**: User can disable if needed

## Consequences

### Positive
✅ **Automatic**: Works without manual configuration per formation
✅ **Efficient**: One-time detection, not per-lesson
✅ **Graceful**: Falls back if detection fails
✅ **Transparent**: Logs detection result for visibility
✅ **Simple config**: Just enable/disable + timing control

### Negative
❌ **Extra navigation**: Adds one retry when first blocked (minor overhead)
❌ **Detection failure**: If detection fails, extraction may fail on formations that truly require completion marking
❌ **Assumption**: Assumes uniform behavior across all lessons in a formation (if lesson 2 requires marking, all following lessons will too)

### Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Detection false positive (lesson accessible for other reason) | Minimal impact - just marks lessons unnecessarily |
| Detection false negative (blocking persists after marking) | Log clearly and abandon feature gracefully |
| Platform changes button selectors | Use robust selectors, log failures clearly |
| Timing issues (wait too short) | Make wait time configurable |

## Alternatives Considered

### Alternative 1: Manual Configuration
```typescript
lessonCompletion: {
  enabled: boolean;  // User manually enables per formation
}
```
**Rejected because:** Requires user to know formation behavior upfront and configure manually

### Alternative 2: Always-On Marking
Always mark every lesson as complete without detection.

**Rejected because:** Unnecessary overhead for formations that don't require it, may cause unexpected side effects

### Alternative 3: Per-Formation Settings Database
Maintain a database of known formations and their requirements.

**Rejected because:** Maintenance burden, doesn't scale to new/unknown formations

### Alternative 4: Smart Retry on Every Lesson
Try to access each next lesson, if blocked, mark current lesson complete.

**Rejected because:** Too much overhead, detection once is sufficient

## Implementation Notes

### Files to Modify
1. **`src/config.ts`**: Add `lessonCompletion` interface and defaults
2. **`src/lesson-completion.ts`** (new): Detection and marking logic
3. **`src/cli/extract.ts`**: Integrate into extraction loop
4. **`extraction-config.schema.json`**: Add schema for new config

### Key Functions
- `markLessonComplete(mcpClient, lessonUrl)`: Click button + confirm
- `detectCompletionRequirement(mcpClient, currentUrl, nextUrl)`: Detection logic
- Integration in extraction loop with `requiresCompletion` state flag

## References
- Example formation requiring completion: https://formations.example.academy/mon-espace/formations/my-course
- Related discussion: Implementation session 2025-11-08
