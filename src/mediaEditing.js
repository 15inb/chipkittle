import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const MEDIA_TMP_DIR = path.join(tmpdir(), "chipkittle-media");
const MAX_GIF_DIMENSION = 720;
const DEFAULT_STATIC_GIF_SECONDS = 3;

function extFromMimeType(mimeType) {
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  return ".bin";
}

function captionText(value) {
  return String(value || "")
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ffmpegFilterPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function assEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r\n|\r|\n/g, "\\N");
}

function wrapCaptionLines(text, maxChars) {
  const lines = [];
  for (const rawLine of captionText(text).split("\n")) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > maxChars && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [captionText(text)];
}

function captionLayout(text, width = 720) {
  const fontSize = Math.max(24, Math.min(48, Math.floor(width / 15)));
  const lineSpacing = Math.max(2, Math.floor(fontSize / 10));
  const verticalPadding = Math.max(8, Math.floor(fontSize * 0.22));
  const lines = wrapCaptionLines(text, Math.max(18, Math.floor(width / (fontSize * 0.5))));
  const boxHeight = Math.max(64, Math.min(220, Math.ceil((fontSize + lineSpacing) * lines.length + verticalPadding * 2)));
  const textCenterY = Math.floor(boxHeight / 2);
  return { boxHeight, fontSize, lineSpacing, lines, textCenterY };
}

function buildCaptionAss({ text, width = 720 }) {
  const { fontSize, lineSpacing, lines, textCenterY } = captionLayout(text, width);
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    "PlayResY: 720",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Caption,Arial,${fontSize},&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,1,0,0,5,24,24,0,1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 0,0:00:00.00,9:59:59.00,Caption,,0,0,0,,{\\q2\\fsp0\\fnArial\\b1\\an5\\fs${fontSize}\\blur0\\shad0\\bord0\\pos(${Math.floor(width / 2)},${textCenterY})\\1c&H000000&}${assEscape(lines.join("\n"))}`,
    ""
  ].join("\n");
}

function esmCaptionFilter({ assPath, text, width = 720 } = {}) {
  const { boxHeight } = captionLayout(text, width);
  return [
    `scale=${width}:-1:flags=lanczos`,
    `pad=iw:ih+${boxHeight}:0:${boxHeight}:white`,
    `subtitles='${ffmpegFilterPath(assPath)}':original_size=${width}x720`
  ].join(",");
}

function gifFinalizeChain(baseFilter) {
  return `${baseFilter},split[g0][g1];[g0]palettegen=reserve_transparent=on[p];[g1][p]paletteuse=dither=bayer:bayer_scale=4`;
}

function scaledFilter(width, height) {
  if (width && height) {
    return `scale=${width}:${height}:flags=lanczos`;
  }

  if (width) {
    return `scale=${width}:-1:flags=lanczos`;
  }

  if (height) {
    return `scale=-1:${height}:flags=lanczos`;
  }

  return `scale='min(${MAX_GIF_DIMENSION},iw)':-1:flags=lanczos`;
}

async function ensureMediaDir() {
  await mkdir(MEDIA_TMP_DIR, { recursive: true });
}

async function runFfmpeg(args) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static is not available.");
  }

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`Could not start ffmpeg: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim() || "unknown error"}`));
    });
  });
}

async function withMediaFiles(media, task) {
  await ensureMediaDir();
  const workDir = path.join(MEDIA_TMP_DIR, randomUUID());
  await mkdir(workDir, { recursive: true });

  const inputPath = path.join(workDir, `input${extFromMimeType(media.mimeType)}`);
  await writeFile(inputPath, media.buffer);

  try {
    return await task({ workDir, inputPath });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readOutput(filePath) {
  return readFile(filePath);
}

function staticInputArgs(inputPath, seconds) {
  return ["-loop", "1", "-t", String(seconds), "-i", inputPath];
}

export async function captionMedia(media, { topText = "", bottomText = "", forceGif = false } = {}) {
  const caption = captionText([topText, bottomText].filter((part) => String(part || "").trim()).join("\n"));
  if (!caption) {
    throw new Error("Give me some caption text first.");
  }

  return withMediaFiles(media, async ({ workDir, inputPath }) => {
    const isGif = media.mimeType === "image/gif";
    const assPath = path.join(workDir, "caption.ass");

    if (isGif || forceGif) {
      const outputPath = path.join(workDir, "captioned.gif");
      const sourceArgs = isGif ? ["-i", inputPath] : staticInputArgs(inputPath, DEFAULT_STATIC_GIF_SECONDS);
      await writeFile(assPath, buildCaptionAss({ text: caption, width: MAX_GIF_DIMENSION }));
      const filter = gifFinalizeChain(`${esmCaptionFilter({ assPath, text: caption, width: MAX_GIF_DIMENSION })},fps=15`);

      await runFfmpeg([
        "-y",
        ...sourceArgs,
        "-filter_complex",
        filter,
        "-gifflags",
        "+transdiff",
        outputPath
      ]);

      return {
        buffer: await readOutput(outputPath),
        filename: "captioned.gif",
        mimeType: "image/gif"
      };
    }

    const outputPath = path.join(workDir, "captioned.png");
    await writeFile(assPath, buildCaptionAss({ text: caption, width: 1024 }));
    const captionFilter = esmCaptionFilter({ assPath, text: caption, width: 1024 });
    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-vf",
      captionFilter,
      "-frames:v",
      "1",
      outputPath
    ]);

    return {
      buffer: await readOutput(outputPath),
      filename: "captioned.png",
      mimeType: "image/png"
    };
  });
}

export async function convertToGif(media) {
  return withMediaFiles(media, async ({ workDir, inputPath }) => {
    const outputPath = path.join(workDir, "output.gif");
    const sourceArgs = media.mimeType === "image/gif"
      ? ["-i", inputPath]
      : staticInputArgs(inputPath, 1);
    const filter = gifFinalizeChain(`fps=15,${scaledFilter()}`);

    await runFfmpeg([
      "-y",
      ...sourceArgs,
      "-filter_complex",
      filter,
      "-gifflags",
      "+transdiff",
      outputPath
    ]);

    return {
      buffer: await readOutput(outputPath),
      filename: "output.gif",
      mimeType: "image/gif"
    };
  });
}

export async function gifReverse(media) {
  if (media.mimeType !== "image/gif") {
    throw new Error("Reverse only works on GIF attachments right now.");
  }

  return withMediaFiles(media, async ({ workDir, inputPath }) => {
    const outputPath = path.join(workDir, "reverse.gif");
    const filter = gifFinalizeChain(`reverse,fps=15,${scaledFilter()}`);

    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-filter_complex",
      filter,
      "-gifflags",
      "+transdiff",
      outputPath
    ]);

    return {
      buffer: await readOutput(outputPath),
      filename: "reverse.gif",
      mimeType: "image/gif"
    };
  });
}

export async function gifSpeed(media, factor) {
  if (media.mimeType !== "image/gif") {
    throw new Error("Speed only works on GIF attachments right now.");
  }

  const safeFactor = Number(factor);
  if (!Number.isFinite(safeFactor) || safeFactor <= 0) {
    throw new Error("Speed must be a number greater than 0.");
  }

  return withMediaFiles(media, async ({ workDir, inputPath }) => {
    const outputPath = path.join(workDir, "speed.gif");
    const filter = gifFinalizeChain(`setpts=PTS/${safeFactor},fps=15,${scaledFilter()}`);

    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-filter_complex",
      filter,
      "-gifflags",
      "+transdiff",
      outputPath
    ]);

    return {
      buffer: await readOutput(outputPath),
      filename: "speed.gif",
      mimeType: "image/gif"
    };
  });
}

export async function gifBoomerang(media) {
  if (media.mimeType !== "image/gif") {
    throw new Error("Boomerang only works on GIF attachments right now.");
  }

  return withMediaFiles(media, async ({ workDir, inputPath }) => {
    const outputPath = path.join(workDir, "boomerang.gif");
    const filter = `[0:v]split[fwd][rev];[rev]reverse[back];[fwd][back]concat=n=2:v=1:a=0,${gifFinalizeChain(`fps=15,${scaledFilter()}`)}`;

    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-filter_complex",
      filter,
      "-gifflags",
      "+transdiff",
      outputPath
    ]);

    return {
      buffer: await readOutput(outputPath),
      filename: "boomerang.gif",
      mimeType: "image/gif"
    };
  });
}

export async function gifResize(media, { width, height }) {
  if (media.mimeType !== "image/gif") {
    throw new Error("Resize only works on GIF attachments right now.");
  }

  return withMediaFiles(media, async ({ workDir, inputPath }) => {
    const outputPath = path.join(workDir, "resize.gif");
    const filter = gifFinalizeChain(`fps=15,${scaledFilter(width, height)}`);

    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-filter_complex",
      filter,
      "-gifflags",
      "+transdiff",
      outputPath
    ]);

    return {
      buffer: await readOutput(outputPath),
      filename: "resize.gif",
      mimeType: "image/gif"
    };
  });
}

export async function gifWiggle(media, { seconds = 3 } = {}) {
  const duration = Math.max(2, Math.min(6, Number(seconds) || 3));

  return withMediaFiles(media, async ({ workDir, inputPath }) => {
    const outputPath = path.join(workDir, "wiggle.gif");
    const sourceArgs = media.mimeType === "image/gif"
      ? ["-i", inputPath]
      : staticInputArgs(inputPath, duration);
    const filter = gifFinalizeChain(`fps=18,rotate='0.06*sin(2*PI*t*2)':ow=rotw(iw):oh=roth(ih):c=0x00000000,${scaledFilter()}`);

    await runFfmpeg([
      "-y",
      ...sourceArgs,
      "-filter_complex",
      filter,
      "-gifflags",
      "+transdiff",
      outputPath
    ]);

    return {
      buffer: await readOutput(outputPath),
      filename: "wiggle.gif",
      mimeType: "image/gif"
    };
  });
}
