# ADR 007: Fix S3 Media File Collision Bug

**Date:** 2025-11-09
**Status:** Accepted
**Deciders:** Development Team

## Context

When extracting lessons with multiple S3 videos (type `video_s3`), all videos from the same lesson were being overwritten because they shared the same filename.

### The Bug

The filename generation for S3 media only used `lessonId + media.type`:

```typescript
// ❌ BUG: All S3 videos in same lesson have identical name
const outputPath = resolve(outputDir, `lesson-${safeId}-${media.type}.${extension}`);
// → lesson-1027365-video_s3.mp4 (for ALL 3 videos!)
```

**Impact:**
- Only the last S3 video was saved (previous ones overwritten)
- Transcriptions were duplicated 3x in `fullContent`
- AI formatting detected duplication → 66% content reduction
- Combined with speech-to-text cleanup → 84% total reduction

**Example:**
Lesson 1027365 had 3 different S3 videos:
1. `9fd2e57f471d2d3f9c927a1fea8266d4.mp4`
2. `1815a001b67b256de003c498ea5b8ff.mp4`
3. `d91bb613a97b956ed15cf50d2e2fb3d4.mp4`

All downloaded to the same path → only #3 survived → its transcription repeated 3x.

## Decision

Generate unique filenames by extracting a hash from the S3 URL:

```typescript
// ✅ FIX: Extract unique hash from URL
const urlHash = media.url.split('/').pop()?.split('.')[0]?.substring(0, 8) || media.mediaId || 'unknown';
const outputPath = resolve(outputDir, `lesson-${safeId}-${media.type}-${urlHash}.${extension}`);
// → lesson-1027365-video_s3-9fd2e57f.mp4 ✅
// → lesson-1027365-video_s3-1815a001.mp4 ✅
// → lesson-1027365-video_s3-d91bb613.mp4 ✅
```

This approach:
- Uses first 8 chars of S3 filename hash (already unique)
- Falls back to `mediaId` if URL parsing fails
- Falls back to `'unknown'` as last resort
- Matches naming pattern used by YouTube (`youtube-${mediaId}`) and Vimeo (`vimeo-${mediaId}`)

## Consequences

### Positive
- ✅ Each S3 video gets unique filename
- ✅ No more file collisions/overwrites
- ✅ All transcriptions preserved correctly
- ✅ Thumbnails also unique (`lesson-${safeId}-video_s3-${hash}-thumb.jpg`)
- ✅ Consistent with YouTube/Vimeo naming pattern

### Negative
- ⚠️ Existing downloaded S3 media will have old naming (won't be recognized by resume mode)
- ⚠️ Users must re-download S3 media for affected lessons

### Migration
Lessons affected by this bug (found via report analysis):
1. **1027365** - Chapter 2: 3 S3 videos (only last transcription saved 3x)
2. **1028633** - Chapter 3: Multiple S3 videos
3. **1028634** - Chapter 3: Multiple S3 videos
4. **1028650** - Chapter 4: Multiple S3 videos
5. **1068394** - Chapter 7: Multiple S3 videos
6. **1073710** - Chapter 11: Multiple S3 videos

**Action required:** Re-extract these lessons with `skipMedia: false` to download all unique videos.

## Files Changed
- `src/media-handler.ts:573` - Added unique hash to S3 download filename
- `src/media-handler.ts:717` - Added unique hash to S3 thumbnail filename
