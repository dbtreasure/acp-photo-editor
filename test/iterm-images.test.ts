import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  buildItermSequence, 
  buildItermMultipartSequences,
  isITerm2,
  isTmux
} from '../src/common/iterm-images';

describe('iTerm2 Image Renderer', () => {
  let originalEnv: NodeJS.ProcessEnv;
  
  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });
  
  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });
  
  describe('Terminal Detection', () => {
    it('detects iTerm2 correctly', () => {
      process.env.TERM_PROGRAM = 'iTerm.app';
      expect(isITerm2()).toBe(true);
      
      process.env.TERM_PROGRAM = 'Terminal.app';
      expect(isITerm2()).toBe(false);
      
      delete process.env.TERM_PROGRAM;
      expect(isITerm2()).toBe(false);
    });
    
    it('detects tmux correctly', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      expect(isTmux()).toBe(true);
      
      delete process.env.TMUX;
      expect(isTmux()).toBe(false);
      
      process.env.TMUX = '';
      expect(isTmux()).toBe(false);
    });
  });
  
  describe('OSC 1337 Sequence Generation', () => {
    const ESC = '\x1b';
    const BEL = '\x07';
    
    it('builds simple OSC 1337 sequence correctly', () => {
      const testImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const sequence = buildItermSequence(testImage, { name: 'test.png' });
      
      // Should start with ESC]1337;File=
      expect(sequence.startsWith(`${ESC}]1337;File=`)).toBe(true);
      
      // Should end with BEL
      expect(sequence.endsWith(BEL)).toBe(true);
      
      // Should contain the base64 image data
      expect(sequence).toContain(`:${testImage}${BEL}`);
      
      // Should contain encoded name
      const encodedName = Buffer.from('test.png').toString('base64');
      expect(sequence).toContain(`name=${encodedName}`);
      
      // Should contain default dimensions
      expect(sequence).toContain('width=64ch');
      expect(sequence).toContain('height=auto');
      expect(sequence).toContain('preserveAspectRatio=1');
      expect(sequence).toContain('inline=1');
    });
    
    it('respects custom dimensions', () => {
      const testImage = 'test';
      const sequence = buildItermSequence(testImage, { 
        name: 'custom.jpg',
        width: '100px',
        height: '50%',
        preserveAspectRatio: false
      });
      
      expect(sequence).toContain('width=100px');
      expect(sequence).toContain('height=50%');
      expect(sequence).toContain('preserveAspectRatio=0');
    });
  });
  
  describe('Multipart Sequence Generation', () => {
    const ESC = '\x1b';
    const BEL = '\x07';
    
    it('builds multipart sequences for large images', () => {
      // Create a large base64 string (> 1MB)
      const largeImage = 'A'.repeat(1024 * 1024 + 100); // 1MB + 100 bytes
      const sequences = buildItermMultipartSequences(largeImage, { name: 'large.png' });
      
      // Should have at least 3 sequences: MultipartFile, FilePart(s), FileEnd
      expect(sequences.length).toBeGreaterThanOrEqual(3);
      
      // First should be MultipartFile
      expect(sequences[0].startsWith(`${ESC}]1337;MultipartFile=`)).toBe(true);
      expect(sequences[0]).toContain('inline=1');
      
      // Middle sequences should be FilePart
      expect(sequences[1].startsWith(`${ESC}]1337;FilePart=`)).toBe(true);
      
      // Last should be FileEnd
      expect(sequences[sequences.length - 1]).toBe(`${ESC}]1337;FileEnd${BEL}`);
      
      // Each FilePart should be <= 1MB
      for (let i = 1; i < sequences.length - 1; i++) {
        const partMatch = sequences[i].match(/FilePart=(.+)\x07/);
        if (partMatch) {
          expect(partMatch[1].length).toBeLessThanOrEqual(1024 * 1024);
        }
      }
    });
    
    it('handles small images with single FilePart', () => {
      const smallImage = 'SmallImageData';
      const sequences = buildItermMultipartSequences(smallImage, { name: 'small.png' });
      
      // Should have exactly 3 sequences: MultipartFile, one FilePart, FileEnd
      expect(sequences.length).toBe(3);
      
      // Check FilePart contains the entire image
      expect(sequences[1]).toBe(`${ESC}]1337;FilePart=${smallImage}${BEL}`);
    });
  });
  
  describe('Base64 Encoding', () => {
    it('correctly encodes filenames', () => {
      const testCases = [
        { input: 'simple.png', expected: 'c2ltcGxlLnBuZw==' },
        { input: 'with spaces.jpg', expected: 'd2l0aCBzcGFjZXMuanBn' },
        { input: 'unicode-😀.png', expected: 'dW5pY29kZS3wn5iALnBuZw==' }
      ];
      
      for (const { input, expected } of testCases) {
        const sequence = buildItermSequence('data', { name: input });
        expect(sequence).toContain(`name=${expected}`);
      }
    });
  });
});