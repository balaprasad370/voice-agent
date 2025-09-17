import fs from "node:fs";
import path from "node:path";

// Optimized WAV header for μ-law 8kHz mono
export function createWavHeader() {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(0, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(7, 20); // μ-law format code
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(8000, 24); // Sample rate
  header.writeUInt32LE(8000, 28); // Byte rate = 8000 * 1 * 1
  header.writeUInt16LE(1, 32); // Block align
  header.writeUInt16LE(8, 34); // Bits per sample
  header.write("data", 36);
  header.writeUInt32LE(0, 40); // Placeholder for data size
  return header;
}

export function updateWavFileSize(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const dataSize = fileSize - 44;
    const fileBuffer = fs.readFileSync(filePath);
    fileBuffer.writeUInt32LE(fileSize - 8, 4);
    fileBuffer.writeUInt32LE(dataSize, 40);
    fs.writeFileSync(filePath, fileBuffer);
  } catch (error) {
    console.error("Error updating WAV file size:", error);
  }
}

export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Create or recreate the WAV file with header
export function startWavFile(filePath) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, createWavHeader());
}

// Append a base64 μ-law payload synchronously
export function appendUlawBase64(filePath, base64Payload) {
  const ulawChunk = Buffer.from(base64Payload, "base64");
  fs.appendFileSync(filePath, ulawChunk);
}

// Finalize WAV by updating sizes
export function finalizeWav(filePath) {
  updateWavFileSize(filePath);
}


