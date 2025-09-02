/**
 * Terminal image rendering utilities.
 * Provides renderer implementations for various terminal protocols.
 */

const BEL = "\x07";
const ESC = "\x1b";

export interface TerminalImageOptions {
  name?: string;
  width?: string; // N cells, Npx pixels, N%, or 'auto'
  height?: string; // N cells, Npx pixels, N%, or 'auto'
  preserveAspectRatio?: boolean;
}

export interface TerminalImageRenderer {
  /**
   * Render an image encoded in base64.
   * Returns the escape sequence(s) that would be written. If an output stream
   * is provided, sequences are also written to that stream.
   */
  render(
    b64Image: string,
    opts?: TerminalImageOptions,
    out?: NodeJS.WritableStream
  ): string[];
}

/** Encode string to base64 */
function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

/** Check if running in iTerm2 */
export function isITerm2(): boolean {
  return process.env.TERM_PROGRAM === "iTerm.app" || !!process.env.ITERM_SESSION_ID;
}

/** Check if running inside tmux */
export function isTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * iTerm2 implementation using OSC 1337 protocol with tmux support.
 */
export class Iterm2Renderer implements TerminalImageRenderer {
  render(
    b64Image: string,
    opts?: TerminalImageOptions,
    out?: NodeJS.WritableStream
  ): string[] {
    const name = b64(opts?.name || "image.png");
    const width = opts?.width || "64"; // Default to 64 cells
    const height = opts?.height || "auto";
    const preserveAspectRatio = opts?.preserveAspectRatio !== false ? 1 : 0;

    const args = `name=${name};inline=1;width=${width};height=${height};preserveAspectRatio=${preserveAspectRatio}`;

    const sequences: string[] = [];
    const inTmux = isTmux();

    if (!inTmux) {
      sequences.push(`${ESC}]1337;File=${args}:${b64Image}${BEL}\n`);
    } else {
      const useMultipart =
        !!process.env.ITERM_SESSION_ID && process.env.TMUX_MULTIPART !== "off";
      if (useMultipart) {
        sequences.push(`${ESC}]1337;MultipartFile=${args}${BEL}`);
        const CHUNK_SIZE = 1024 * 1024;
        for (let i = 0; i < b64Image.length; i += CHUNK_SIZE) {
          const chunk = b64Image.slice(i, Math.min(i + CHUNK_SIZE, b64Image.length));
          sequences.push(`${ESC}]1337;FilePart=${chunk}${BEL}`);
        }
        sequences.push(`${ESC}]1337;FileEnd${BEL}\n`);
      } else {
        const sequence = `${ESC}]1337;File=${args}:${b64Image}${BEL}`;
        sequences.push(`${ESC}Ptmux;${ESC}${sequence}${ESC}\\\n`);
      }
    }

    if (out) {
      for (const seq of sequences) {
        out.write(seq);
      }
    }

    return sequences;
  }
}

/** Placeholder for Kitty graphics protocol renderer */
export class KittyRenderer implements TerminalImageRenderer {
  render(
    _b64Image: string,
    _opts?: TerminalImageOptions,
    _out?: NodeJS.WritableStream
  ): string[] {
    // TODO: implement Kitty graphics protocol
    return [];
  }
}

/** Fallback renderer that emits a simple placeholder */
export class AsciiRenderer implements TerminalImageRenderer {
  render(
    _b64Image: string,
    _opts?: TerminalImageOptions,
    out?: NodeJS.WritableStream
  ): string[] {
    const placeholder = "[image omitted]";
    if (out) {
      out.write(placeholder + "\n");
    }
    return [placeholder];
  }
}
