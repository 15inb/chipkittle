import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const MEDIA_TMP_DIR = path.join(tmpdir(), "chipkittle-media");
const MAX_GIF_DIMENSION = 720;
const DEFAULT_STATIC_GIF_SECONDS = 3;
const FFMPEG_TIMEOUT_MS = 45_000;

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
  // Mirrors esmBot's MIT-licensed native caption sizing: font = width / 10,
  // caption text width = width - 2 * (width / 25), banner = text height + font size.
  const fontSize = Math.max(14, Math.floor(width / 10));
  const lineSpacing = Math.max(1, Math.floor(fontSize / 12));
  const textWidth = Math.max(1, width - Math.floor(width / 25) * 2);
  const lines = wrapCaptionLines(text, Math.max(8, Math.floor(textWidth / (fontSize * 0.58))));
  const estimatedTextHeight = Math.ceil(fontSize * 0.82 * lines.length + lineSpacing * Math.max(0, lines.length - 1));
  const boxHeight = Math.max(fontSize + 18, Math.ceil(estimatedTextHeight + fontSize));
  const textCenterY = Math.floor(boxHeight / 2);
  return { boxHeight, fontSize, lineSpacing, lines, textCenterY, textWidth };
}

function buildCaptionAss({ text, width = 720, canvasHeight = 720 }) {
  const { fontSize, lineSpacing, lines, textCenterY, textWidth } = captionLayout(text, width);
  const margin = Math.max(0, Math.floor((width - textWidth) / 2));
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${canvasHeight}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: Caption,Arial,${fontSize},&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,1,0,0,5,${margin},${margin},0,1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 0,0:00:00.00,9:59:59.00,Caption,,0,0,0,,{\\q2\\fsp0\\fnArial\\b1\\an5\\fs${fontSize}\\blur0\\shad0\\bord0\\pos(${Math.floor(width / 2)},${textCenterY})\\1c&H000000&}${assEscape(lines.join("\n"))}`,
    ""
  ].join("\n");
}

function esmCaptionFilter({ assPath, text, width = 720, canvasHeight = 720 } = {}) {
  const { boxHeight } = captionLayout(text, width);
  return [
    `scale='min(${MAX_GIF_DIMENSION},iw)':-1:flags=lanczos`,
    `pad=iw:ih+${boxHeight}:0:${boxHeight}:white`,
    `subtitles='${ffmpegFilterPath(assPath)}':original_size=${width}x${canvasHeight}`
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
    const child = spawn(ffmpegPath, ["-nostdin", ...args], { windowsHide: true });
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(reject, new Error(`Could not start ffmpeg: ${error.message}`));
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish(reject, new Error(`Media editing timed out after ${Math.round(FFMPEG_TIMEOUT_MS / 1000)} seconds. Try a smaller or shorter file.`));
        return;
      }
      if (code === 0) {
        finish(resolve);
        return;
      }
      finish(reject, new Error(`ffmpeg exited with code ${code}: ${stderr.trim() || "unknown error"}`));
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
    const dimensions = await mediaDimensions(inputPath);
    const captionWidth = Math.min(MAX_GIF_DIMENSION, dimensions.width);
    const scaledHeight = Math.max(1, Math.round(dimensions.height * (captionWidth / dimensions.width)));
    const canvasHeight = scaledHeight + captionLayout(caption, captionWidth).boxHeight;

    if (isGif || forceGif) {
      const outputPath = path.join(workDir, "captioned.gif");
      const sourceArgs = isGif ? ["-i", inputPath] : staticInputArgs(inputPath, DEFAULT_STATIC_GIF_SECONDS);
      await writeFile(assPath, buildCaptionAss({ text: caption, width: captionWidth, canvasHeight }));
      const filter = gifFinalizeChain(`${esmCaptionFilter({ assPath, text: caption, width: captionWidth, canvasHeight })},fps=15`);

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
    await writeFile(assPath, buildCaptionAss({ text: caption, width: captionWidth, canvasHeight }));
    const captionFilter = esmCaptionFilter({ assPath, text: caption, width: captionWidth, canvasHeight });
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

async function mediaDimensions(inputPath) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static is not available.");
  }

  const stderr = await new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-i", inputPath], { windowsHide: true });
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", () => resolve(output));
    child.on("error", () => resolve(""));
  });
  const match = stderr.match(/Video:[^\n,]*,[^\n]*?(\d{2,5})x(\d{2,5})/);
  if (!match) return { width: MAX_GIF_DIMENSION, height: MAX_GIF_DIMENSION };
  return {
    width: Math.max(1, Number(match[1]) || MAX_GIF_DIMENSION),
    height: Math.max(1, Number(match[2]) || MAX_GIF_DIMENSION)
  };
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
