/**
 * iTerm2 inline image rendering support
 * Implements OSC 1337 protocol with tmux multipart support
 */

const BEL = '\x07';
const ESC = '\x1b';

export interface ItermImageOptions {
  name?: string;
  width?: string; // N cells, Npx pixels, N%, or 'auto'
  height?: string; // N cells, Npx pixels, N%, or 'auto'
  preserveAspectRatio?: boolean;
}

/**
 * Encode string to base64
 */
function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

/**
 * Check if running in iTerm2
 */
export function isITerm2(): boolean {
  return process.env.TERM_PROGRAM === 'iTerm.app' || !!process.env.ITERM_SESSION_ID;
}

/**
 * Check if running inside tmux
 */
export function isTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Display an image inline in iTerm2
 * Automatically uses multipart mode when running in tmux
 *
 * @param b64Image Base64 encoded image data
 * @param opts Display options
 */
export function itermShowImage(b64Image: string, opts?: ItermImageOptions): void {
  const name = b64(opts?.name || 'image.png');
  const width = opts?.width || '64'; // Default to 64 cells (not '64ch')
  const height = opts?.height || 'auto';
  const preserveAspectRatio = opts?.preserveAspectRatio !== false ? 1 : 0;

  const args = `name=${name};inline=1;width=${width};height=${height};preserveAspectRatio=${preserveAspectRatio}`;

  const inTmux = isTmux();

  if (!inTmux) {
    // Simple mode (no tmux)
    process.stdout.write(`${ESC}]1337;File=${args}:${b64Image}${BEL}\n`);
    return;
  }

  // Tmux mode: try multipart first, fallback to DCS passthrough
  const useMultipart = !!process.env.ITERM_SESSION_ID && process.env.TMUX_MULTIPART !== 'off';

  if (useMultipart) {
    // Multipart mode (tmux-safe) - iTerm2 3.5+
    process.stdout.write(`${ESC}]1337;MultipartFile=${args}${BEL}`);

    // Chunk size: 1MB per iTerm2/tmux guidance
    const CHUNK_SIZE = 1024 * 1024;

    for (let i = 0; i < b64Image.length; i += CHUNK_SIZE) {
      const chunk = b64Image.slice(i, Math.min(i + CHUNK_SIZE, b64Image.length));
      process.stdout.write(`${ESC}]1337;FilePart=${chunk}${BEL}`);
    }

    process.stdout.write(`${ESC}]1337;FileEnd${BEL}\n`);
  } else {
    // DCS passthrough fallback for older tmux versions
    // Wrap the OSC sequence in tmux DCS passthrough
    const sequence = `${ESC}]1337;File=${args}:${b64Image}${BEL}`;
    process.stdout.write(`${ESC}Ptmux;${ESC}${sequence}${ESC}\\\n`);
  }
}

/**
 * Build OSC 1337 sequence for testing (doesn't write to stdout)
 */
export function buildItermSequence(b64Image: string, opts?: ItermImageOptions): string {
  const name = b64(opts?.name || 'image.png');
  const width = opts?.width || '64'; // Default to 64 cells (not '64ch')
  const height = opts?.height || 'auto';
  const preserveAspectRatio = opts?.preserveAspectRatio !== false ? 1 : 0;

  const args = `name=${name};inline=1;width=${width};height=${height};preserveAspectRatio=${preserveAspectRatio}`;

  return `${ESC}]1337;File=${args}:${b64Image}${BEL}`;
}

/**
 * Build multipart sequences for testing
 */
export function buildItermMultipartSequences(b64Image: string, opts?: ItermImageOptions): string[] {
  const name = b64(opts?.name || 'image.png');
  const width = opts?.width || '64'; // Default to 64 cells (not '64ch')
  const height = opts?.height || 'auto';
  const preserveAspectRatio = opts?.preserveAspectRatio !== false ? 1 : 0;

  const args = `name=${name};inline=1;width=${width};height=${height};preserveAspectRatio=${preserveAspectRatio}`;

  const sequences: string[] = [];
  sequences.push(`${ESC}]1337;MultipartFile=${args}${BEL}`);

  const CHUNK_SIZE = 1024 * 1024;

  for (let i = 0; i < b64Image.length; i += CHUNK_SIZE) {
    const chunk = b64Image.slice(i, Math.min(i + CHUNK_SIZE, b64Image.length));
    sequences.push(`${ESC}]1337;FilePart=${chunk}${BEL}`);
  }

  sequences.push(`${ESC}]1337;FileEnd${BEL}`);

  return sequences;
}
