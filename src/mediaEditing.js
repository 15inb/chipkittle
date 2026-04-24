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

function drawTextEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%");
}

function esmCaptionFilter({ text, width = 720 } = {}) {
  const safeText = drawTextEscape(captionText(text));
  const fontSize = Math.max(28, Math.min(54, Math.floor(width / 13)));
  const lineSpacing = Math.max(4, Math.floor(fontSize / 7));
  const horizontalPadding = Math.max(18, Math.floor(width * 0.04));
  const verticalPadding = Math.max(16, Math.floor(fontSize * 0.55));
  const estimatedLines = Math.max(1, safeText.split(/\\n|\n/).length);
  const boxHeight = Math.max(96, Math.min(260, (fontSize + lineSpacing) * estimatedLines + verticalPadding * 2));
  const textY = Math.max(8, Math.floor((boxHeight - fontSize * estimatedLines - lineSpacing * Math.max(0, estimatedLines - 1)) / 2));

  return [
    `scale='min(${width},iw)':-1:flags=lanczos`,
    `pad=iw:ih+${boxHeight}:0:${boxHeight}:white`,
    `drawtext=text='${safeText}':fontcolor=black:fontsize=${fontSize}:font='Arial':x=${horizontalPadding}:y=${textY}:line_spacing=${lineSpacing}:box=0`
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

    if (isGif || forceGif) {
      const outputPath = path.join(workDir, "captioned.gif");
      const sourceArgs = isGif ? ["-i", inputPath] : staticInputArgs(inputPath, DEFAULT_STATIC_GIF_SECONDS);
      const filter = gifFinalizeChain(`${esmCaptionFilter({ text: caption })},fps=15`);

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
    const captionFilter = esmCaptionFilter({ text: caption, width: 1024 });
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
