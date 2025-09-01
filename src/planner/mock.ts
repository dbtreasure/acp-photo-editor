import { Planner, PlannerInput, PlannerOutput, PlannedCall } from './types';

export class MockPlanner implements Planner {
  plan(input: PlannerInput): PlannerOutput {
    const text = input.text.toLowerCase();
    const calls: PlannedCall[] = [];
    const notes: string[] = [];
    const ignoredTerms: string[] = [];

    // Track cumulative adjustments for incremental commands
    let totalTemp = 0;
    let totalTint = 0;
    let totalEv = 0;
    let totalContrast = 0;
    let totalAngle = 0;

    // Split text into tokens for processing
    const tokens = text.split(/[\s,;]+/).filter((t) => t.length > 0);
    let i = 0;

    while (i < tokens.length) {
      const token = tokens[i];
      const nextToken = tokens[i + 1];
      const nextNextToken = tokens[i + 2];

      // White Balance adjustments
      if (token === 'warmer' || token === 'warm') {
        totalTemp += 20;
        i++;
      } else if (token === 'cooler' || token === 'cool') {
        // Handle "cool by N" pattern
        if (nextToken === 'by' && nextNextToken && !isNaN(Number(nextNextToken))) {
          totalTemp -= Number(nextNextToken);
          i += 3;
        } else {
          totalTemp -= 20;
          i++;
        }
      } else if (token === 'temp' && nextToken && this.isNumberWithSign(nextToken)) {
        totalTemp += Number(nextToken);
        i += 2;
      } else if (token === 'tint' && nextToken && this.isNumberWithSign(nextToken)) {
        totalTint += Number(nextToken);
        i += 2;
      } else if ((token === 'neutral' && nextToken === 'wb') || (token === 'auto' && nextToken === 'wb')) {
        calls.push({ fn: 'set_white_balance_gray', args: { x: 0.5, y: 0.5 } });
        i += 2;
      }
      // Exposure adjustments
      else if (token === 'brighter' || token === 'lift') {
        totalEv += 0.3;
        i++;
      } else if (token === 'darker') {
        totalEv -= 0.3;
        i++;
      } else if (token === 'ev' && nextToken && this.isNumberWithSign(nextToken)) {
        totalEv += Number(nextToken);
        i += 2;
      } else if (nextToken === 'ev' && this.isNumberWithSign(token)) {
        // Handle "+0.5 ev" pattern
        totalEv += Number(token);
        i += 2;
      }
      // Contrast adjustments
      else if (token === 'more' && nextToken === 'contrast') {
        totalContrast += 20;
        i += 2;
      } else if (token === 'punchier') {
        totalContrast += 20;
        i++;
      } else if (token === 'less' && nextToken === 'contrast') {
        totalContrast -= 20;
        i += 2;
      } else if (token === 'flatter') {
        totalContrast -= 20;
        i++;
      } else if (token === 'contrast' && nextToken && this.isNumberWithSign(nextToken)) {
        totalContrast += Number(nextToken);
        i += 2;
      }
      // Crop and aspect ratios
      else if (token === 'crop') {
        // Check for specific aspect after crop
        if (nextToken === 'square' || nextToken === '1:1') {
          calls.push({ fn: 'set_crop', args: { aspect: '1:1' } });
          i += 2;
        } else if (nextToken === '16:9') {
          calls.push({ fn: 'set_crop', args: { aspect: '16:9' } });
          i += 2;
        } else if (nextToken === '3:2') {
          calls.push({ fn: 'set_crop', args: { aspect: '3:2' } });
          i += 2;
        } else if (nextToken === '4:3') {
          calls.push({ fn: 'set_crop', args: { aspect: '4:3' } });
          i += 2;
        } else {
          i++;
        }
      } else if (token === 'square' || token === '1:1') {
        calls.push({ fn: 'set_crop', args: { aspect: '1:1' } });
        i++;
      } else if (token === '16:9') {
        calls.push({ fn: 'set_crop', args: { aspect: '16:9' } });
        i++;
      } else if (token === '3:2') {
        calls.push({ fn: 'set_crop', args: { aspect: '3:2' } });
        i++;
      } else if (token === '4:3') {
        calls.push({ fn: 'set_crop', args: { aspect: '4:3' } });
        i++;
      }
      // Straighten/rotate
      else if (token === 'straighten' || token === 'rotate') {
        if (nextToken && this.isNumberWithSign(nextToken)) {
          // Remove degree symbol if present
          const degrees = nextToken.replace(/°$/, '');
          totalAngle += Number(degrees);
          i += 2;
        } else {
          i++;
        }
      }
      // Undo/Redo/Reset
      else if (token === 'undo') {
        calls.push({ fn: 'undo' });
        i++;
      } else if (token === 'redo') {
        calls.push({ fn: 'redo' });
        i++;
      } else if (token === 'reset') {
        calls.push({ fn: 'reset' });
        i++;
      }
      // Export
      else if (token === 'export' || token === 'save') {
        const exportArgs: any = {};
        i++;

        // Look for "to <path>"
        if (tokens[i] === 'to' && tokens[i + 1]) {
          exportArgs.dst = tokens[i + 1];
          i += 2;
        }

        // Look for format
        while (i < tokens.length) {
          if (tokens[i] === 'as' && tokens[i + 1]) {
            if (tokens[i + 1] === 'png' || tokens[i + 1] === 'jpeg' || tokens[i + 1] === 'jpg') {
              exportArgs.format = tokens[i + 1] === 'jpg' ? 'jpeg' : tokens[i + 1];
            }
            i += 2;
          } else if (tokens[i] === 'quality' && tokens[i + 1]) {
            exportArgs.quality = Number(tokens[i + 1]);
            i += 2;
          } else if (tokens[i] === 'overwrite') {
            exportArgs.overwrite = true;
            i++;
          } else {
            break;
          }
        }

        calls.push({ fn: 'export_image', args: Object.keys(exportArgs).length > 0 ? exportArgs : undefined });
      }
      // Unknown token
      else {
        // Check if it's just a number (might be part of a compound expression)
        if (!this.isNumberWithSign(token) && !['by', 'to', 'as'].includes(token)) {
          ignoredTerms.push(token);
        }
        i++;
      }
    }

    // Add accumulated adjustments as operations - BEFORE crop operations
    const finalCalls: PlannedCall[] = [];

    // Add non-crop operations first
    for (const call of calls) {
      if (call.fn !== 'set_crop') {
        finalCalls.push(call);
      }
    }

    // Add accumulated adjustments
    if (totalTemp !== 0 || totalTint !== 0) {
      finalCalls.push({ fn: 'set_white_balance_temp_tint', args: { temp: totalTemp, tint: totalTint } });
    }
    if (totalEv !== 0) {
      finalCalls.push({ fn: 'set_exposure', args: { ev: totalEv } });
    }
    if (totalContrast !== 0) {
      finalCalls.push({ fn: 'set_contrast', args: { amt: totalContrast } });
    }

    // Add crop operations last (combine with angle if needed)
    const cropCalls = calls.filter((c) => c.fn === 'set_crop');
    if (cropCalls.length > 0 || totalAngle !== 0) {
      if (cropCalls.length > 0) {
        const lastCrop = cropCalls[cropCalls.length - 1] as any;
        if (totalAngle !== 0) {
          lastCrop.args.angleDeg = totalAngle;
        }
        finalCalls.push(lastCrop);
      } else {
        finalCalls.push({ fn: 'set_crop', args: { angleDeg: totalAngle } });
      }
    }

    // Replace calls with finalCalls
    calls.length = 0;
    calls.push(...finalCalls);

    // Add note about ignored terms
    if (ignoredTerms.length > 0) {
      notes.push(`Ignored terms: ${ignoredTerms.join(', ')}`);
    }

    return { calls, notes };
  }

  private isNumberWithSign(str: string): boolean {
    // Handle numbers with optional + or - prefix, and optional degree symbol
    const cleaned = str.replace(/°$/, '');
    return /^[+-]?\d+(\.\d+)?$/.test(cleaned);
  }
}
