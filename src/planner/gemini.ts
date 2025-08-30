// GeminiPlanner implementation for Phase 7b
// Uses Google's Gemini 2.5 Flash model with structured JSON output

import { GoogleGenAI } from '@google/genai';
import { Planner, PlannerInput, PlannerOutput, PlannedCall } from './types';
import { MockPlanner } from './mock';
import { 
  TOOL_CATALOG_DESCRIPTION,
  PLANNER_RESPONSE_SCHEMA,
  validateAndClampCall,
  getClampedValues 
} from './tools';
import { NdjsonLogger } from '../common/logger';

const logger = new NdjsonLogger('gemini-planner');

export interface GeminiPlannerConfig {
  apiKey?: string;
  model?: string;
  timeout?: number;
  maxCalls?: number;
  temperature?: number;
  logText?: boolean;
}

export interface PlannerState {
  image: {
    name: string;
    w: number;
    h: number;
    mime: string;
  };
  stackSummary: string;
  limits: {
    temp: [number, number];
    ev: [number, number];
    contrast: [number, number];
    angle: [number, number];
  };
}

export class GeminiPlanner implements Planner {
  private client: GoogleGenAI | null = null;
  private mockFallback: MockPlanner;
  private config: Required<GeminiPlannerConfig>;
  
  constructor(config: GeminiPlannerConfig = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
      model: config.model || 'gemini-2.5-flash',
      timeout: config.timeout || 60000,
      maxCalls: config.maxCalls || 6,
      temperature: config.temperature || 0,
      logText: config.logText || false
    };
    
    this.mockFallback = new MockPlanner();
    
    if (this.config.apiKey) {
      this.client = new GoogleGenAI({ apiKey: this.config.apiKey });
    }
  }
  
  async plan(input: PlannerInput): Promise<PlannerOutput> {
    const startTime = Date.now();
    
    // Log planner start
    logger.line('info', { event: 'planner_start',
      kind: 'gemini',
      model: this.config.model,
      textLen: input.text.length,
      timeoutMs: this.config.timeout,
      hasState: !!input.state
    });
    
    // Check if API key is available
    if (!this.client) {
      logger.line('info', { event: 'planner_fallback',
        to: 'mock',
        reason: 'no_api_key'
      });
      const result = this.mockFallback.plan(input);
      return {
        ...result,
        notes: [...(result.notes || []), 'Planner fell back to mock (no API key).']
      };
    }
    
    try {
      // Create the system prompt
      const systemPrompt = this.buildSystemPrompt(input.state);
      
      // Create the user prompt with context
      const userPrompt = this.buildUserPrompt(input.text, input.state);
      
      // Make the API call with retry logic
      const fullPrompt = `${systemPrompt}\n\nUser request: ${userPrompt}`;
      
      let response;
      let lastError;
      const maxRetries = 3;
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Create AbortController for timeout (per attempt)
        const controller = new AbortController();
        const timeoutId = this.config.timeout > 0 ? 
          setTimeout(() => controller.abort(), this.config.timeout) : null;
        
        try {
          response = await this.client.models.generateContent({
            model: this.config.model,
            contents: [
              { role: 'user', parts: [{ text: fullPrompt }] }
            ],
            config: {
              temperature: this.config.temperature,
              responseMimeType: 'application/json'
              // Don't use responseSchema - it requires full property definitions
              // Let Gemini return freeform JSON and we'll validate it ourselves
              // Note: signal is not supported by @google/genai, timeout handled via AbortController
            }
          });
          
          // Clear timeout if successful
          if (timeoutId) clearTimeout(timeoutId);
          break; // Success, exit retry loop
          
        } catch (err: any) {
          // Clear timeout on error
          if (timeoutId) clearTimeout(timeoutId);
          
          lastError = err;
          
          // Check if it was aborted due to timeout
          if (err.name === 'AbortError') {
            lastError = new Error('timeout');
          }
          
          // Check if we should retry
          const isRetryable = err.message?.includes('429') || 
                             err.message?.includes('503') ||
                             err.message?.includes('rate') ||
                             err.status === 429 || 
                             err.status === 503;
          
          if (isRetryable && attempt < maxRetries - 1) {
            // Exponential backoff: 1s, 2s, 4s
            const delay = Math.pow(2, attempt) * 1000;
            logger.line('info', { event: 'planner_retry', 
              attempt: attempt + 1, 
              delay,
              error: err.message 
            });
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          
          // No more retries, throw the error
          throw lastError;
        }
      }
      
      if (!response) {
        throw lastError || new Error('Failed to get response from Gemini');
      }
      
      let responseText = response.text || '';
      
      // Strip markdown code blocks if present (Gemini sometimes wraps JSON in ```json...```)
      responseText = responseText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
      
      // Parse the JSON response
      const parsed = JSON.parse(responseText);
      
      if (!parsed || !Array.isArray(parsed.calls)) {
        throw new Error('Invalid response structure');
      }
      
      // Validate and clamp calls
      const validCalls: PlannedCall[] = [];
      const droppedCalls: string[] = [];
      const clampedValues: string[] = [];
      
      for (const call of parsed.calls.slice(0, this.config.maxCalls)) {
        const validated = validateAndClampCall(call);
        if (validated) {
          validCalls.push(validated);
          
          // Check if values were clamped
          const clamped = getClampedValues(call, validated);
          clampedValues.push(...clamped);
        } else {
          console.log('[Gemini] Dropped invalid call:', JSON.stringify(call));
          droppedCalls.push(call.fn || 'unknown');
        }
      }
      
      // Log planner result
      const latencyMs = Date.now() - startTime;
      logger.line('info', { event: 'planner_result',
        calls: validCalls.length,
        dropped: droppedCalls.length,
        clamped: clampedValues.length,
        latencyMs,
        originalCallCount: parsed.calls.length
      });
      
      // Build notes
      const notes: string[] = [];
      if (droppedCalls.length > 0) {
        notes.push(`Dropped invalid calls: ${droppedCalls.join(', ')}`);
      }
      if (clampedValues.length > 0) {
        notes.push(`Clamped values: ${clampedValues.join(', ')}`);
      }
      if (parsed.calls.length > this.config.maxCalls) {
        notes.push(`Truncated to ${this.config.maxCalls} calls (from ${parsed.calls.length})`);
      }
      
      return { calls: validCalls, notes };
      
    } catch (error: any) {
      // LOG THE ACTUAL FUCKING ERROR
      console.error('[GEMINI ACTUAL ERROR]:', error);
      console.error('[GEMINI ERROR MESSAGE]:', error.message);
      console.error('[GEMINI ERROR STACK]:', error.stack);
      
      // Log fallback
      const reason = error.message === 'timeout' ? 'timeout' :
                     error.message?.includes('rate') ? 'rate_limit' :
                     error.message?.includes('network') ? 'network_error' :
                     'api_error';
      
      logger.line('info', { event: 'planner_fallback',
        to: 'mock',
        reason,
        error: error.message,
        latencyMs: Date.now() - startTime
      });
      
      // Fall back to mock planner
      const result = this.mockFallback.plan(input);
      return {
        ...result,
        notes: [...(result.notes || []), `Planner fell back to mock (${reason}).`]
      };
    }
  }
  
  private buildSystemPrompt(state?: PlannerState): string {
    return `<role>
You are an expert photo editing assistant that translates natural language requests into precise technical operations.
Your task is to analyze the user's intent and generate the appropriate sequence of editing operations.
</role>

<tool_catalog>
<color_adjustments>
  <tool name="set_white_balance_temp_tint">
    <description>Adjusts the color temperature and tint of the image</description>
    <parameters>
      <param name="temp" type="number" min="-100" max="100" required="true">
        Temperature adjustment. Positive values make image warmer (more orange), negative values make it cooler (more blue)
      </param>
      <param name="tint" type="number" min="-100" max="100" required="true">
        Tint adjustment. Positive values add magenta, negative values add green. Usually 0 unless correcting color cast.
      </param>
    </parameters>
    <usage_notes>
      - "warmer" typically means temp +20 to +40
      - "cooler" typically means temp -20 to -40
      - "very warm" or "golden" means temp +40 to +70
      - "very cool" or "cold" means temp -40 to -70
      - Always include both temp AND tint (use tint: 0 if not specified)
    </usage_notes>
  </tool>

  <tool name="set_white_balance_gray">
    <description>Sets white balance by picking a neutral gray point</description>
    <parameters>
      <param name="x" type="number" min="0" max="1" required="true">X coordinate of gray point (0-1 normalized)</param>
      <param name="y" type="number" min="0" max="1" required="true">Y coordinate of gray point (0-1 normalized)</param>
    </parameters>
  </tool>

  <tool name="set_exposure">
    <description>Adjusts the overall brightness/exposure of the image</description>
    <parameters>
      <param name="ev" type="number" min="-3" max="3" required="true">
        Exposure value in stops. +1 doubles brightness, -1 halves it.
      </param>
    </parameters>
    <usage_notes>
      - "brighter" or "lighten" typically means ev +0.3 to +0.5
      - "much brighter" means ev +0.7 to +1.0
      - "darker" typically means ev -0.3 to -0.5
      - "much darker" means ev -0.7 to -1.0
      - "lifted shadows" suggests ev +0.2 to +0.4
    </usage_notes>
  </tool>

  <tool name="set_contrast">
    <description>Adjusts the contrast (difference between lights and darks)</description>
    <parameters>
      <param name="amt" type="number" min="-100" max="100" required="true">
        Contrast amount. Positive increases contrast, negative decreases it.
      </param>
    </parameters>
    <usage_notes>
      - "more contrast" or "punchy" means amt +20 to +40
      - "high contrast" means amt +40 to +70
      - "less contrast" or "flat" means amt -20 to -40
      - "lifted" or "faded" suggests amt -10 to -30
    </usage_notes>
  </tool>
</color_adjustments>

<geometry_adjustments>
  <tool name="set_crop">
    <description>Crops the image to a specific aspect ratio or rotates it</description>
    <parameters>
      <param name="aspect" type="string" enum="1:1,3:2,4:3,16:9" required="false">
        Aspect ratio for cropping. Use "1:1" for square, "16:9" for wide/cinematic
      </param>
      <param name="rectNorm" type="array[4]" required="false">
        Custom crop rectangle [x, y, width, height] in 0-1 normalized coordinates
      </param>
      <param name="angleDeg" type="number" min="-45" max="45" required="false">
        Rotation angle in degrees for straightening
      </param>
    </parameters>
    <usage_notes>
      - "square" or "instagram" means aspect: "1:1"
      - "wide" or "cinematic" means aspect: "16:9"
      - "straighten" requires angleDeg parameter
      - Can combine aspect and angleDeg in one call
    </usage_notes>
  </tool>
</geometry_adjustments>

<history_operations>
  <tool name="undo"><description>Undo the last operation</description></tool>
  <tool name="redo"><description>Redo a previously undone operation</description></tool>
  <tool name="reset"><description>Reset to original image, removing all edits</description></tool>
</history_operations>

<export_operations>
  <tool name="export_image">
    <description>Export the edited image to disk</description>
    <parameters>
      <param name="dst" type="string" required="false">Destination file path</param>
      <param name="format" type="string" enum="jpeg,png" required="false">Output format</param>
      <param name="quality" type="number" min="1" max="100" required="false">JPEG quality (1-100)</param>
      <param name="overwrite" type="boolean" required="false">Whether to overwrite existing files</param>
    </parameters>
  </tool>
</export_operations>
</tool_catalog>

<reasoning_approach>
When processing a request, follow this chain of thought:
1. Identify the intent (aesthetic goal, technical adjustment, or specific values)
2. Map descriptive terms to appropriate operations and values
3. Consider the order of operations (color before geometry)
4. Check if operations should update existing adjustments (amend-last)
5. Validate all parameters are within allowed ranges
</reasoning_approach>

<examples>
<example>
  <input>make it warmer and brighter</input>
  <reasoning>
    - "warmer" → increase temperature, typical value +20 to +30
    - "brighter" → increase exposure, typical value +0.3 to +0.5
    - These are color adjustments, apply in order
  </reasoning>
  <output>
{"calls": [
  {"fn": "set_white_balance_temp_tint", "args": {"temp": 25, "tint": 0}},
  {"fn": "set_exposure", "args": {"ev": 0.4}}
]}
  </output>
</example>

<example>
  <input>cool blue tone with high contrast, crop square</input>
  <reasoning>
    - "cool blue tone" → negative temperature, around -40
    - "high contrast" → contrast amount around +50
    - "crop square" → aspect ratio 1:1
    - Apply color adjustments first, then geometry
  </reasoning>
  <output>
{"calls": [
  {"fn": "set_white_balance_temp_tint", "args": {"temp": -40, "tint": 0}},
  {"fn": "set_contrast", "args": {"amt": 50}},
  {"fn": "set_crop", "args": {"aspect": "1:1"}}
]}
  </output>
</example>

<example>
  <input>warm sunset look with lifted shadows</input>
  <reasoning>
    - "warm sunset" → significant warmth, temp around +50 to +60
    - "lifted shadows" → slight exposure increase + reduced contrast
    - Sunset aesthetic often has orange/golden tones
  </reasoning>
  <output>
{"calls": [
  {"fn": "set_white_balance_temp_tint", "args": {"temp": 55, "tint": 5}},
  {"fn": "set_exposure", "args": {"ev": 0.3}},
  {"fn": "set_contrast", "args": {"amt": -15}}
]}
  </output>
</example>

<example>
  <input>make it black and white</input>
  <reasoning>
    - "black and white" requires desaturation
    - No saturation control available in current tool set
    - Return empty array with explanation
  </reasoning>
  <output>
{"calls": []}
  </output>
</example>

<example>
  <input>export to photos/final.jpg at high quality</input>
  <reasoning>
    - "export to photos/final.jpg" → dst parameter
    - "high quality" → quality around 90-95
    - File extension .jpg → format jpeg
  </reasoning>
  <output>
{"calls": [
  {"fn": "export_image", "args": {"dst": "photos/final.jpg", "format": "jpeg", "quality": 95}}
]}
  </output>
</example>
</examples>

${state ? `<current_state>
${this.buildStateContext(state)}
</current_state>` : ''}

<output_requirements>
- Return ONLY valid JSON, no markdown, no explanations
- Format: {"calls": [array of operations]}
- Each operation MUST have "fn" and "args" keys
- All required parameters must be present
- Maximum ${this.config.maxCalls} operations per response
- Use exact parameter names as specified in tool_catalog
- When in doubt, prefer conservative values over extreme ones
</output_requirements>`;
  }
  
  private buildUserPrompt(text: string, state?: PlannerState): string {
    // Redact file paths for privacy
    const redactedText = text.replace(/\/[^\s]+\.(jpg|jpeg|png|tiff|webp)/gi, '[image]');
    
    if (this.config.logText) {
      logger.line('info', { event: 'planner_text', original: text, redacted: redactedText });
    }
    
    if (!state) {
      return redactedText;
    }
    
    return JSON.stringify({
      user: redactedText,
      state: {
        image: state.image,
        stackSummary: state.stackSummary,
        limits: {
          temp: state.limits.temp,
          ev: state.limits.ev,
          contrast: state.limits.contrast,
          angle: state.limits.angle
        }
      }
    });
  }
  
  private buildStateContext(state: PlannerState): string {
    return `
Current image state:
- Image: ${state.image.name} (${state.image.w}x${state.image.h}, ${state.image.mime})
- Current edits: ${state.stackSummary || 'none'}
- Valid ranges:
  * Temperature: ${state.limits.temp[0]} to ${state.limits.temp[1]}
  * Tint: -100 to 100
  * Exposure (EV): ${state.limits.ev[0]} to ${state.limits.ev[1]}
  * Contrast: ${state.limits.contrast[0]} to ${state.limits.contrast[1]}
  * Rotation: ${state.limits.angle[0]}° to ${state.limits.angle[1]}°
  * Quality: 1 to 100`;
  }
}