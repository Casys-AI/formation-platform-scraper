# ADR 008: Fix Transcription Race Condition

**Date:** 2025-11-09
**Status:** Accepted
**Deciders:** Development Team

## Context

After fixing the S3 media file collision bug (ADR-007), we discovered a race condition causing transcription failures during bulk extraction.

### The Bug

Multiple parallel processes were trying to transcribe the same media file, causing failures:

```
Process A: Download MP4 → Transcribe → Convert MP4→MP3 → Delete MP4 ✅
Process B: Download MP4 → Transcribe → ❌ CRASH (MP4 deleted by Process A)
```

**Error Log:**
```
✅ MP3 conversion successful - lesson-1022471-video_s3-cf7f005d.mp3
❌ Transcription failed: ENOENT: no such file or directory, stat '.../lesson-1022471-video_s3-cf7f005d.mp4'
```

**Root Causes:**
1. **Race Condition**: `transcribeAudio()` was converting MP4→MP3 internally, and multiple parallel calls would conflict
2. **Wrong Path Storage**: `media.localPath` stored the MP4 path, but the MP4 was deleted after conversion → resume mode would fail

### Impact

- **Lessons affected**: Any lesson with multiple S3 videos (video_s3 type)
- **Resume mode broken**: Stored paths pointed to non-existent MP4 files
- **Random failures**: Depending on parallel process timing

## Decision

Restructure media processing flow to eliminate race condition:

### New Flow (in `processLessonMedia()`)

```typescript
// 1. Download media
let audioPath = await downloadS3Media(media, outputDir, lessonId);
// → audioPath = "lesson-1027365-video_s3-9fd2e57f.mp4"

// 2. Extract screenshot BEFORE conversion (needs MP4 for video_s3)
if (!skipScreenshots && media.type === 'video_s3') {
  screenshotPath = await extractS3VideoThumbnail(audioPath, outputDir, lessonId);
}

// 3. Convert MP4 → MP3 (AFTER screenshot extraction)
if (media.type === 'video_s3' && audioPath.endsWith('.mp4')) {
  logger.info('🔄 Converting MP4 → MP3 for Whisper compatibility');
  audioPath = await convertMp4ToMp3(audioPath); // Deletes MP4, returns MP3 path
  // → audioPath = "lesson-1027365-video_s3-9fd2e57f.mp3"
}

// 4. Store final path (MP3 for video_s3, original for others)
media.localPath = audioPath; // ✅ Now stores MP3 path

// 5. Transcribe (receives MP3 directly - no conversion needed)
transcription = await transcribeAudio(audioPath);
```

### Changes Made

**File: `src/media-handler.ts`**

1. **Lines 991-1020** - Added MP4→MP3 conversion in `processLessonMedia()`:
   ```typescript
   // 3. Convert MP4 to MP3 for S3 videos (AFTER screenshot extraction)
   if (media.type === 'video_s3' && audioPath.endsWith('.mp4')) {
     logger.info({ audioPath }, '🔄 Converting MP4 → MP3 for Whisper compatibility');
     audioPath = await convertMp4ToMp3(audioPath);
   }
   // Store final path (MP3 for video_s3, original for others)
   media.localPath = audioPath;
   ```

2. **Lines 779-850** - Simplified `transcribeAudio()`:
   - ❌ Removed: Internal MP4→MP3 conversion logic
   - ✅ Now: Simply transcribes the audio file received (already MP3)
   - No more file deletion inside `transcribeAudio()`

3. **`convertMp4ToMp3()` unchanged** - Still deletes MP4 after conversion

## Consequences

### Positive

- ✅ **No more race condition**: Conversion happens once per media, sequentially
- ✅ **Resume mode fixed**: `media.localPath` points to existing MP3 files
- ✅ **Simpler transcription**: `transcribeAudio()` no longer manages file conversion
- ✅ **Correct ordering**: Screenshot extraction happens before MP4 deletion
- ✅ **Parallel processing safe**: Each lesson's media processed independently

### Negative

- ⚠️ **Existing JSONs invalid**: Old lesson JSONs point to deleted MP4 files → must re-extract
- ⚠️ **Migration required**: 13 lessons from ADR-007 must be re-extracted

### Testing

Manual test on lesson 1022471:
- ✅ MP4 downloaded
- ✅ Screenshot extracted from MP4
- ✅ MP4 converted to MP3 (MP4 deleted)
- ✅ MP3 path stored in `media.localPath`
- ✅ Transcription successful (using MP3)
- ✅ No race condition errors

## Files Changed

- `src/media-handler.ts:991-1020` - Added MP4→MP3 conversion in processLessonMedia()
- `src/media-handler.ts:779-850` - Simplified transcribeAudio() (removed conversion)

## Related ADRs

- **ADR-007**: Fix S3 Media File Collision Bug (prerequisite fix)
