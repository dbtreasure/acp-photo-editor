// GeminiPlanner implementation for Phase 7b
// Uses Google's Gemini 2.5 Flash model with structured JSON output

import { GoogleGenAI } from '@google/genai';
import { Planner, PlannerInput, PlannerOutput, PlannedCall } from './types';
import { MockPlanner } from './mock';
import { TOOL_CATALOG_DESCRIPTION, PLANNER_RESPONSE_SCHEMA, validateAndClampCall, getClampedValues } from './tools';
import { NdjsonLogger } from '../common/logger';
import { withSpan, addSpanEvent, getTraceId } from '../telemetry/tracing';

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
  // Phase 7e: Reference image support
  refStats?: {
    w: number;
    h: number;
    mime: string;
    L: { p5: number; p50: number; p95: number; mean: number; stdev: number };
    AB: { a_mean: number; b_mean: number; chroma_mean: number };
    sat: { hsv_mean: number; hsv_p95: number; colorfulness: number };
    contrast_index: number;
  };
  suggestedDeltas?: {
    temp?: number;
    tint?: number;
    ev?: number;
    contrast?: number;
    saturation?: number;
    vibrance?: number;
    rotate?: number;
    aspect?: string;
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
      logText: config.logText || false,
    };

    this.mockFallback = new MockPlanner();

    if (this.config.apiKey) {
      this.client = new GoogleGenAI({ apiKey: this.config.apiKey });
    }
  }

  async plan(input: PlannerInput): Promise<PlannerOutput> {
    const startTime = Date.now();
    const hasVision = !!input.imageB64;

    // Log planner start
    logger.line('info', {
      event: 'planner_start',
      kind: 'gemini',
      vision: hasVision,
      model: this.config.model,
      textLen: input.text.length,
      timeoutMs: this.config.timeout,
      hasState: !!input.state,
      imageBytes: hasVision ? Math.round(input.imageB64!.length * 0.75) : undefined,
    });

    // Check if API key is available
    if (!this.client) {
      logger.line('info', { event: 'planner_fallback', to: 'mock', reason: 'no_api_key' });
      const result = this.mockFallback.plan(input);
      return {
        ...result,
        notes: [...(result.notes || []), 'Planner fell back to mock (no API key).'],
      };
    }

    try {
      // Create the system prompt (vision-specific for Phase 7c if image present)
      const systemPrompt = hasVision ? this.buildVisionSystemPrompt(input.state) : this.buildSystemPrompt(input.state);

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
        const timeoutId = this.config.timeout > 0 ? setTimeout(() => controller.abort(), this.config.timeout) : null;

        try {
          // Build content parts based on whether we have vision
          const contentParts = hasVision
            ? [
                { text: fullPrompt },
                {
                  inlineData: {
                    mimeType: 'image/jpeg',
                    data: input.imageB64!,
                  },
                },
              ]
            : [{ text: fullPrompt }];

          response = await withSpan('gemini.api_call', async (apiSpan) => {
            apiSpan.setAttributes({
              'api.model': this.config.model,
              'api.temperature': this.config.temperature,
              'api.attempt': attempt + 1,
              'api.has_image': hasVision
            });
            
            return await this.client!.models.generateContent({
              model: this.config.model,
              contents: [{ role: 'user', parts: contentParts }],
              config: {
                temperature: this.config.temperature,
                responseMimeType: 'application/json',
                // Don't use responseSchema - it requires full property definitions
                // Let Gemini return freeform JSON and we'll validate it ourselves
                // Note: signal is not supported by @google/genai, timeout handled via AbortController
              },
            });
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
          const isRetryable =
            err.message?.includes('429') ||
            err.message?.includes('503') ||
            err.message?.includes('rate') ||
            err.status === 429 ||
            err.status === 503;

          if (isRetryable && attempt < maxRetries - 1) {
            // Exponential backoff: 1s, 2s, 4s
            const delay = Math.pow(2, attempt) * 1000;
            logger.line('info', { event: 'planner_retry', attempt: attempt + 1, delay, error: err.message });
            await new Promise((resolve) => setTimeout(resolve, delay));
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

      // Log raw response length for telemetry

      // Strip markdown code blocks if present (Gemini sometimes wraps JSON in ```json...```)
      responseText = responseText
        .replace(/^```(?:json)?\s*\n?/, '')
        .replace(/\n?```\s*$/, '')
        .trim();

      // Parse the JSON response
      const parsed = JSON.parse(responseText);

      if (!parsed || !Array.isArray(parsed.calls)) {
        throw new Error('Invalid response structure');
      }
      
      // Phase 7f: Extract confidence and clarification fields
      const confidence = typeof parsed.confidence === 'number' ? 
        Math.max(0, Math.min(1, parsed.confidence)) : 1.0;
      const needsClarification = parsed.needsClarification || undefined;

      // Validate and clamp calls
      const validCalls: PlannedCall[] = [];
      const droppedCalls: string[] = [];
      const clampedValues: string[] = [];

      for (const call of parsed.calls.slice(0, this.config.maxCalls)) {
        // Normalize the call format (Gemini may return tool_name/parameters instead of fn/args)
        const normalizedCall = {
          fn: call.fn || call.tool_name || call.function,
          args: call.args || call.parameters || call.arguments,
        };

        // Log each call for debugging
        logger.line('info', {
          event: 'processing_call',
          call: JSON.stringify(call),
          hasVision,
          normalized: JSON.stringify(normalizedCall),
        });

        // Phase 7d: All operations are now allowed in vision mode

        const validated = validateAndClampCall(normalizedCall);
        if (validated) {
          validCalls.push(validated);

          // Check if values were clamped
          const clamped = getClampedValues(normalizedCall, validated);
          clampedValues.push(...clamped.map(c => `${c.name}: ${c.from} → ${c.to}`));
        } else {
          logger.line('info', { event: 'dropped_invalid', fn: normalizedCall.fn });
          droppedCalls.push(normalizedCall.fn || 'unknown');
        }
      }

      // Log planner result
      const latencyMs = Date.now() - startTime;
      logger.line('info', {
        event: 'planner_result',
        calls: validCalls.length,
        dropped: droppedCalls.length,
        clamped: clampedValues.length,
        latencyMs,
        originalCallCount: parsed.calls.length,
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

      // Log enhanced telemetry
      logger.line('info', {
        event: 'planner_complete',
        calls_list: validCalls.map(c => c.fn).join(','),
        calls_planned: parsed.calls.length,
        calls_valid: validCalls.length,
        calls_dropped: droppedCalls.length,
        values_clamped: clampedValues.length,
        has_vision: hasVision,
        latencyMs: latencyMs,
        confidence: confidence,
        needs_clarification: !!needsClarification,
      });

      return { 
        calls: validCalls, 
        notes,
        confidence,
        needsClarification
      };
    } catch (error: any) {
      // Log fallback
      const reason =
        error.message === 'timeout'
          ? 'timeout'
          : error.message?.includes('rate')
            ? 'rate_limit'
            : error.message?.includes('network')
              ? 'network_error'
              : 'api_error';

      logger.line('info', {
        event: 'planner_fallback',
        to: 'mock',
        reason,
        error: error.message,
        latencyMs: Date.now() - startTime,
        has_vision: !!input.imageB64,
      });

      // Fall back to mock planner
      const result = this.mockFallback.plan(input);
      return {
        ...result,
        notes: [...(result.notes || []), `Planner fell back to mock (${reason}).`],
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

  <tool name="set_saturation">
    <description>Adjusts the color saturation (intensity) of the image</description>
    <parameters>
      <param name="amt" type="number" min="-100" max="100" required="true">
        Saturation amount. Positive increases color intensity, negative decreases. -100 makes image black and white.
      </param>
    </parameters>
    <usage_notes>
      - "more colorful" or "vibrant" means amt +20 to +40
      - "less colorful" or "muted" means amt -20 to -40
      - "black and white" or "desaturated" means amt -100
    </usage_notes>
  </tool>

  <tool name="set_vibrance">
    <description>Adjusts vibrance (smart saturation that protects skin tones)</description>
    <parameters>
      <param name="amt" type="number" min="-100" max="100" required="true">
        Vibrance amount. Affects less-saturated colors more than already vibrant ones.
      </param>
    </parameters>
    <usage_notes>
      - Better than saturation for portraits with people
      - "vibrant" means amt +30 to +50
      - Preserves natural skin tones while enhancing other colors
    </usage_notes>
  </tool>
</color_adjustments>

<geometry_adjustments>
  <tool name="set_rotate">
    <description>Rotates the image to straighten horizons or correct tilt</description>
    <parameters>
      <param name="angleDeg" type="number" min="-45" max="45" required="true">
        Rotation angle in degrees. Positive rotates clockwise, negative counter-clockwise.
      </param>
    </parameters>
    <usage_notes>
      - "straighten" or "level horizon" typically needs 1-3 degrees
      - "rotate slightly" means 5-10 degrees
      - "rotate significantly" means 15-30 degrees
    </usage_notes>
  </tool>

  <tool name="set_crop">
    <description>Crops the image to a specific aspect ratio or custom rectangle</description>
    <parameters>
      <param name="aspect" type="string" enum="1:1,3:2,4:3,16:9" required="false">
        Aspect ratio for cropping. Use "1:1" for square, "16:9" for wide/cinematic
      </param>
      <param name="rectNorm" type="array[4]" required="false">
        Custom crop rectangle [x, y, width, height] in 0-1 normalized coordinates
      </param>
    </parameters>
    <usage_notes>
      - "square" or "instagram" means aspect: "1:1"
      - "wide" or "cinematic" means aspect: "16:9"
      - "portrait" typically means aspect: "3:2" or "4:3"
      - rectNorm allows precise custom cropping
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

${
  state
    ? `<current_state>
${this.buildStateContext(state)}
</current_state>`
    : ''
}

<output_requirements>
- Return ONLY valid JSON, no markdown, no explanations
- Format: {"calls": [array of operations], "confidence": 0.0-1.0, "needsClarification": {...}}
- Each operation MUST have "fn" and "args" keys
- All required parameters must be present
- Maximum ${this.config.maxCalls} operations per response
- Use exact parameter names as specified in tool_catalog
- When in doubt, prefer conservative values over extreme ones
- IMPORTANT for Phase 7f:
  * Include "confidence" (0-1) indicating how certain you are about the interpretation
  * If user intent is ambiguous (confidence < 0.5), set "needsClarification" with:
    - "question": clarifying question to ask
    - "options": array of possible interpretations (optional)
    - "context": additional context (optional)
  * Common ambiguous terms: "cinematic", "pop", "punch", "moody", "dramatic", "better"
  * When clarification is needed, still provide your best guess in "calls" but with low confidence
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

    const stateObj: any = {
      user: redactedText,
      state: {
        image: state.image,
        stackSummary: state.stackSummary,
        limits: {
          temp: state.limits.temp,
          ev: state.limits.ev,
          contrast: state.limits.contrast,
          angle: state.limits.angle,
        },
      },
    };

    // Phase 7e: Include reference stats and suggested deltas if present
    if (state.refStats) {
      stateObj.referenceImage = {
        dimensions: `${state.refStats.w}x${state.refStats.h}`,
        luminance: {
          median: state.refStats.L.p50,
          contrast: state.refStats.contrast_index,
        },
        color: {
          a_mean: state.refStats.AB.a_mean,
          b_mean: state.refStats.AB.b_mean,
          colorfulness: state.refStats.sat.colorfulness,
        },
      };
    }

    if (state.suggestedDeltas) {
      stateObj.suggestedAdjustments = state.suggestedDeltas;
      stateObj.note = "These adjustments are computed locally to match the reference image. Prioritize these values unless the user text explicitly overrides them.";
    }

    return JSON.stringify(stateObj);
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

  private buildVisionSystemPrompt(state?: PlannerState): string {
    return `<role>
You are an expert photo editing assistant with visual analysis capabilities.
You can see the image and should analyze it to determine the best editing operations.
In Phase 7d, you can use the FULL tool catalog to edit images based on visual analysis.
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
        Tint adjustment. Positive values add magenta, negative values add green.
      </param>
    </parameters>
    <vision_notes>
      - Analyze overall color cast in the image
      - Look for areas that should be neutral (whites, grays)
      - Warm casts appear orange/yellow, cool casts appear blue
    </vision_notes>
  </tool>

  <tool name="set_white_balance_gray">
    <description>Sets white balance by picking a neutral gray point in the image</description>
    <parameters>
      <param name="x" type="number" min="0" max="1" required="true">X coordinate of gray point (0-1 normalized to the image you see)</param>
      <param name="y" type="number" min="0" max="1" required="true">Y coordinate of gray point (0-1 normalized to the image you see)</param>
    </parameters>
    <vision_notes>
      - Identify neutral references: white shirts, gray concrete, white walls
      - Coordinates are for the preview you see: (0,0) is top-left, (1,1) is bottom-right
      - The agent will map these to the original image space
    </vision_notes>
  </tool>

  <tool name="set_exposure">
    <description>Adjusts the overall brightness/exposure of the image</description>
    <parameters>
      <param name="ev" type="number" min="-3" max="3" required="true">
        Exposure value in stops. +1 doubles brightness, -1 halves it.
      </param>
    </parameters>
    <vision_notes>
      - Analyze histogram distribution and overall brightness
      - Underexposed images have details lost in shadows
      - Overexposed images have blown highlights
      - "Lifted shadows" typically needs +0.3 to +0.5 ev
    </vision_notes>
  </tool>

  <tool name="set_contrast">
    <description>Adjusts the contrast (difference between lights and darks)</description>
    <parameters>
      <param name="amt" type="number" min="-100" max="100" required="true">
        Contrast amount. Positive increases contrast, negative decreases it.
      </param>
    </parameters>
    <vision_notes>
      - Low contrast images appear flat or washed out
      - High contrast has strong blacks and whites
      - Foggy/hazy images benefit from increased contrast
    </vision_notes>
  </tool>

  <tool name="set_saturation">
    <description>Adjusts the color saturation of the image</description>
    <parameters>
      <param name="amt" type="number" min="-100" max="100" required="true">
        Saturation amount. Positive increases color intensity, negative decreases it.
      </param>
    </parameters>
    <vision_notes>
      - Analyze current color intensity
      - Oversaturated images have unnatural, neon-like colors
      - Undersaturated images appear dull or faded
      - -100 creates black and white
    </vision_notes>
  </tool>

  <tool name="set_vibrance">
    <description>Adjusts vibrance (smart saturation that protects skin tones)</description>
    <parameters>
      <param name="amt" type="number" min="-100" max="100" required="true">
        Vibrance amount. Affects less-saturated colors more than already vibrant ones.
      </param>
    </parameters>
    <vision_notes>
      - Better than saturation for portraits
      - Enhances muted colors without oversaturating
      - Preserves skin tone naturalness
    </vision_notes>
  </tool>
</color_adjustments>

<geometry_adjustments>
  <tool name="set_rotate">
    <description>Rotates the image to straighten horizons or correct tilt</description>
    <parameters>
      <param name="angleDeg" type="number" min="-45" max="45" required="true">
        Rotation angle in degrees. Positive rotates clockwise.
      </param>
    </parameters>
    <vision_notes>
      - Look for tilted horizons, buildings, or vertical lines
      - Ocean/lake horizons should be perfectly level
      - Buildings and poles should be vertical
      - Small adjustments (1-3°) often sufficient
    </vision_notes>
  </tool>

  <tool name="set_crop">
    <description>Crops the image to improve composition or aspect ratio</description>
    <parameters>
      <param name="aspect" type="string" enum="1:1,3:2,4:3,16:9" required="false">
        Aspect ratio for cropping
      </param>
      <param name="rectNorm" type="array[4]" required="false">
        Custom crop rectangle [x, y, width, height] in 0-1 normalized coordinates of the preview
      </param>
    </parameters>
    <vision_notes>
      - Apply rule of thirds for better composition
      - Remove distracting elements at edges
      - "square" or "instagram" → aspect: "1:1"
      - "wide" or "cinematic" → aspect: "16:9"
      - For rectNorm: coordinates are for the preview you see
      - The agent will map rectNorm to original image space
    </vision_notes>
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

<vision_analysis_approach>
1. Examine the overall image quality and issues
2. Check for color casts by looking at areas that should be neutral
3. Assess exposure by analyzing shadow and highlight detail
4. Evaluate contrast by looking at tonal range
5. Check if horizon or vertical lines need straightening
6. Consider composition improvements through cropping
7. Determine if colors need enhancement via saturation/vibrance
</vision_analysis_approach>

${
  state
    ? `<current_state>
${this.buildStateContext(state)}
</current_state>`
    : ''
}

<output_requirements>
- Return ONLY valid JSON: {"calls": [array of operations]}
- You can use ANY tool from the catalog based on visual analysis
- Maximum ${this.config.maxCalls} operations per response
- Operations are applied in order: color adjustments → geometry adjustments → export
- For coordinates (gray point, crop rect): use the preview image space (0-1 normalized)
- Include export operations if requested by the user
</output_requirements>`;
  }
}
