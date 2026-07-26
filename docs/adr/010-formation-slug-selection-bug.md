# ADR 010: Formation Slug Selection Bug and Fix

**Date:** 2025-11-09
**Status:** Accepted
**Context:** Bug Discovery and Fix

## Problem

The extraction system was **always extracting the wrong formation** when multiple formations existed in the `output/` directory.

### Symptoms

1. Despite `formation-config.json` specifying `"formationSlug": "example-program"`, the extraction logs showed:
   ```
   Output directory: .../output/example-course/lessons
   ```

2. Extracted lesson content showed "Accès non autorisé" errors because:
   - Lesson IDs from `example-program/course-structure.json` were being used
   - But the extraction was navigating to lesson URLs under `example-course`
   - Platform returned access denied because these IDs don't belong to that formation

### Root Cause

In `src/cli/extract.ts` (line 72), the code called:

```typescript
const structure = await loadCourseStructure(); // NO ARGUMENT!
```

Without a slug argument, `loadCourseStructure()` falls back to:
1. Reading all directories in `output/`
2. Taking the **FIRST** directory alphabetically that contains `course-structure.json`
3. Loading that structure

**Alphabetical order:**
- ✅ `example-course` ← **Selected first!**
- ❌ `example-program` ← Ignored

## Decision

**Fix:** Read `formation-config.json` and pass the slug explicitly to `loadCourseStructure()`.

### Implementation

**File:** `src/cli/extract.ts`

```typescript
// BEFORE (buggy)
const structure = await loadCourseStructure();

// AFTER (fixed)
const formationConfigPath = resolve(process.cwd(), 'formation-config.json');
const formationConfig = JSON.parse(readFileSync(formationConfigPath, 'utf-8'));
const slug = formationConfig.formationSlug;

const structure = await loadCourseStructure(slug);
```

**Added import:**
```typescript
import { readFileSync } from 'fs';
```

## Consequences

### Positive
- ✅ **Correct formation is now extracted**
- ✅ **formation-config.json is now the source of truth** for which formation to extract
- ✅ **No more "Accès non autorisé" errors** caused by ID/formation mismatch
- ✅ **Multi-formation support works correctly**

### Neutral
- `formation-config.json` must exist and contain `formationSlug`
- Error will be thrown if slug doesn't match any discovered formation

### Technical Notes

This bug was introduced because:
1. The discovery process correctly saves structures to `output/{slug}/course-structure.json`
2. But the extraction process didn't know which formation to extract when multiple exist
3. The "first alphabetically" fallback was a reasonable default for single-formation setups
4. But became a silent bug once multiple formations were discovered

## Related

- **Discovered during:** Investigation of "Access Denied" errors in extracted lessons
- **Initial hypothesis:** Lesson completion detection not working
- **Actual issue:** Wrong formation being extracted entirely
- **ADR-001:** Lesson Completion Auto-Detection (unrelated to this bug)

## Verification

To verify the fix works:

```bash
# 1. Check formation-config.json
cat formation-config.json  # Should show "example-program"

# 2. Run extraction
pnpm extract

# 3. Verify output directory
# Should extract to: output/example-program/lessons
# NOT to: output/example-course/lessons
```
