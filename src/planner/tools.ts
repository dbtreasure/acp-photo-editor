// Tool catalog schema generation for Gemini planner
// Exports PlannedCall types as JSON Schema and provides validation utilities

import { PlannedCall, PLANNER_CLAMPS } from './types';

// JSON Schema definitions for each tool in the catalog
export const TOOL_SCHEMAS = {
  set_white_balance_temp_tint: {
    type: 'object',
    properties: {
      fn: { type: 'string', enum: ['set_white_balance_temp_tint'] },
      args: {
        type: 'object',
        properties: {
          temp: { 
            type: 'number',
            minimum: PLANNER_CLAMPS.temp.min,
            maximum: PLANNER_CLAMPS.temp.max,
            description: 'Temperature adjustment (-100 to 100)'
          },
          tint: { 
            type: 'number',
            minimum: PLANNER_CLAMPS.tint.min,
            maximum: PLANNER_CLAMPS.tint.max,
            description: 'Tint adjustment (-100 to 100)'
          }
        },
        required: ['temp', 'tint']
      }
    },
    required: ['fn', 'args']
  },
  
  set_white_balance_gray: {
    type: 'object',
    properties: {
      fn: { type: 'string', enum: ['set_white_balance_gray'] },
      args: {
        type: 'object',
        properties: {
          x: { 
            type: 'number',
            minimum: PLANNER_CLAMPS.grayPoint.min,
            maximum: PLANNER_CLAMPS.grayPoint.max,
            description: 'X coordinate (0 to 1)'
          },
          y: { 
            type: 'number',
            minimum: PLANNER_CLAMPS.grayPoint.min,
            maximum: PLANNER_CLAMPS.grayPoint.max,
            description: 'Y coordinate (0 to 1)'
          }
        },
        required: ['x', 'y']
      }
    },
    required: ['fn', 'args']
  },
  
  set_exposure: {
    type: 'object',
    properties: {
      fn: { type: 'string', enum: ['set_exposure'] },
      args: {
        type: 'object',
        properties: {
          ev: { 
            type: 'number',
            minimum: PLANNER_CLAMPS.ev.min,
            maximum: PLANNER_CLAMPS.ev.max,
            description: 'Exposure value adjustment (-3 to 3)'
          }
        },
        required: ['ev']
      }
    },
    required: ['fn', 'args']
  },
  
  set_contrast: {
    type: 'object',
    properties: {
      fn: { type: 'string', enum: ['set_contrast'] },
      args: {
        type: 'object',
        properties: {
          amt: { 
            type: 'number',
            minimum: PLANNER_CLAMPS.contrast.min,
            maximum: PLANNER_CLAMPS.contrast.max,
            description: 'Contrast amount (-100 to 100)'
          }
        },
        required: ['amt']
      }
    },
    required: ['fn', 'args']
  },
  
  set_crop: {
    type: 'object',
    properties: {
      fn: { type: 'string', enum: ['set_crop'] },
      args: {
        type: 'object',
        properties: {
          aspect: {
            type: 'string',
            enum: ['1:1', '3:2', '4:3', '16:9'],
            description: 'Aspect ratio preset'
          },
          rectNorm: {
            type: 'array',
            items: { type: 'number', minimum: 0, maximum: 1 },
            minItems: 4,
            maxItems: 4,
            description: 'Normalized crop rectangle [x, y, width, height]'
          },
          angleDeg: {
            type: 'number',
            minimum: PLANNER_CLAMPS.angleDeg.min,
            maximum: PLANNER_CLAMPS.angleDeg.max,
            description: 'Rotation angle in degrees (-45 to 45)'
          }
        }
      }
    },
    required: ['fn', 'args']
  },
  
  undo: {
    type: 'object',
    properties: {
      fn: { type: 'string', enum: ['undo'] }
    },
    required: ['fn']
  },
  
  redo: {
    type: 'object',
    properties: {
      fn: { type: 'string', enum: ['redo'] }
    },
    required: ['fn']
  },
  
  reset: {
    type: 'object',
    properties: {
      fn: { type: 'string', enum: ['reset'] }
    },
    required: ['fn']
  },
  
  export_image: {
    type: 'object',
    properties: {
      fn: { type: 'string', enum: ['export_image'] },
      args: {
        type: 'object',
        properties: {
          dst: {
            type: 'string',
            description: 'Destination file path'
          },
          format: {
            type: 'string',
            enum: ['jpeg', 'png'],
            description: 'Export format'
          },
          quality: {
            type: 'number',
            minimum: PLANNER_CLAMPS.quality.min,
            maximum: PLANNER_CLAMPS.quality.max,
            description: 'JPEG quality (1 to 100)'
          },
          overwrite: {
            type: 'boolean',
            description: 'Whether to overwrite existing file'
          }
        }
      }
    },
    required: ['fn']
  }
};

// Complete JSON Schema for the planner response
export const PLANNER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    calls: {
      type: 'array',
      items: {
        oneOf: Object.values(TOOL_SCHEMAS)
      },
      description: 'Array of tool calls to execute'
    }
  },
  required: ['calls']
};

// Tool catalog description for the system prompt
export const TOOL_CATALOG_DESCRIPTION = `
Available photo editing operations:

1. White Balance:
   - set_white_balance_temp_tint: Adjust temperature (-100 to 100) and tint (-100 to 100)
   - set_white_balance_gray: Set gray point using x,y coordinates (0 to 1)

2. Exposure:
   - set_exposure: Adjust exposure value (EV) from -3 to 3

3. Contrast:
   - set_contrast: Adjust contrast amount from -100 to 100

4. Crop & Rotate:
   - set_crop: Set aspect ratio (1:1, 3:2, 4:3, 16:9), custom rectangle, or rotation angle (-45 to 45 degrees)

5. History:
   - undo: Undo last operation
   - redo: Redo previously undone operation
   - reset: Reset to original image

6. Export:
   - export_image: Export with optional destination path, format (jpeg/png), quality (1-100), and overwrite flag

IMPORTANT RULES:
- Use amend-last semantics: if the same type of adjustment already exists, update it rather than adding a new one
- Apply operations in order: color adjustments before geometry (crop/rotate)
- All numeric values will be clamped to their valid ranges
- For incremental adjustments (e.g., "warmer"), use relative values like temp: 20
- For absolute adjustments (e.g., "temp 50"), use the exact value
- Crop and rotate can be combined in a single set_crop call
`;

// Validate and clamp a planned call
export function validateAndClampCall(call: any): PlannedCall | null {
  try {
    // Basic structure validation
    if (!call || typeof call.fn !== 'string') {
      return null;
    }
    
    // Apply clamping based on function type
    const clampedCall = { ...call };
    
    switch (call.fn) {
      case 'set_white_balance_temp_tint':
        if (!call.args || typeof call.args.temp !== 'number' || typeof call.args.tint !== 'number') {
          return null;
        }
        clampedCall.args = {
          temp: clamp(call.args.temp, PLANNER_CLAMPS.temp.min, PLANNER_CLAMPS.temp.max),
          tint: clamp(call.args.tint, PLANNER_CLAMPS.tint.min, PLANNER_CLAMPS.tint.max)
        };
        break;
        
      case 'set_white_balance_gray':
        if (!call.args || typeof call.args.x !== 'number' || typeof call.args.y !== 'number') {
          return null;
        }
        clampedCall.args = {
          x: clamp(call.args.x, PLANNER_CLAMPS.grayPoint.min, PLANNER_CLAMPS.grayPoint.max),
          y: clamp(call.args.y, PLANNER_CLAMPS.grayPoint.min, PLANNER_CLAMPS.grayPoint.max)
        };
        break;
        
      case 'set_exposure':
        if (!call.args || typeof call.args.ev !== 'number') {
          return null;
        }
        clampedCall.args = {
          ev: clamp(call.args.ev, PLANNER_CLAMPS.ev.min, PLANNER_CLAMPS.ev.max)
        };
        break;
        
      case 'set_contrast':
        if (!call.args || typeof call.args.amt !== 'number') {
          return null;
        }
        clampedCall.args = {
          amt: clamp(call.args.amt, PLANNER_CLAMPS.contrast.min, PLANNER_CLAMPS.contrast.max)
        };
        break;
        
      case 'set_crop':
        if (!call.args) {
          return null;
        }
        const cropArgs: any = {};
        if (call.args.aspect && ['1:1', '3:2', '4:3', '16:9'].includes(call.args.aspect)) {
          cropArgs.aspect = call.args.aspect;
        }
        if (Array.isArray(call.args.rectNorm) && call.args.rectNorm.length === 4) {
          cropArgs.rectNorm = call.args.rectNorm.map((v: number) => 
            clamp(v, 0, 1)
          );
        }
        if (typeof call.args.angleDeg === 'number') {
          cropArgs.angleDeg = clamp(call.args.angleDeg, PLANNER_CLAMPS.angleDeg.min, PLANNER_CLAMPS.angleDeg.max);
        }
        if (Object.keys(cropArgs).length === 0) {
          return null;
        }
        clampedCall.args = cropArgs;
        break;
        
      case 'undo':
      case 'redo':
      case 'reset':
        // No args needed
        break;
        
      case 'export_image':
        if (call.args) {
          const exportArgs: any = {};
          if (typeof call.args.dst === 'string') {
            exportArgs.dst = call.args.dst;
          }
          if (call.args.format === 'jpeg' || call.args.format === 'png') {
            exportArgs.format = call.args.format;
          } else if (call.args.format && call.args.format !== 'jpeg' && call.args.format !== 'png') {
            // Invalid format
            return null;
          }
          if (typeof call.args.quality === 'number') {
            exportArgs.quality = clamp(call.args.quality, PLANNER_CLAMPS.quality.min, PLANNER_CLAMPS.quality.max);
          } else if (call.args.quality !== undefined && typeof call.args.quality !== 'number') {
            // Invalid quality type
            return null;
          }
          if (typeof call.args.overwrite === 'boolean') {
            exportArgs.overwrite = call.args.overwrite;
          }
          clampedCall.args = Object.keys(exportArgs).length > 0 ? exportArgs : undefined;
        }
        break;
        
      default:
        // Unknown function
        return null;
    }
    
    return clampedCall as PlannedCall;
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Track what values were clamped for reporting
export function getClampedValues(original: PlannedCall, clamped: PlannedCall): string[] {
  const clampedValues: string[] = [];
  
  if (original.fn !== clamped.fn) return clampedValues;
  
  const origArgs = (original as any).args;
  const clampArgs = (clamped as any).args;
  
  if (!origArgs || !clampArgs) return clampedValues;
  
  switch (original.fn) {
    case 'set_white_balance_temp_tint':
      if (origArgs.temp !== clampArgs.temp) {
        clampedValues.push(`temp clamped from ${origArgs.temp} to ${clampArgs.temp}`);
      }
      if (origArgs.tint !== clampArgs.tint) {
        clampedValues.push(`tint clamped from ${origArgs.tint} to ${clampArgs.tint}`);
      }
      break;
    case 'set_exposure':
      if (origArgs.ev !== clampArgs.ev) {
        clampedValues.push(`EV clamped from ${origArgs.ev} to ${clampArgs.ev}`);
      }
      break;
    case 'set_contrast':
      if (origArgs.amt !== clampArgs.amt) {
        clampedValues.push(`contrast clamped from ${origArgs.amt} to ${clampArgs.amt}`);
      }
      break;
    case 'set_crop':
      if (origArgs.angleDeg !== clampArgs.angleDeg) {
        clampedValues.push(`angle clamped from ${origArgs.angleDeg}° to ${clampArgs.angleDeg}°`);
      }
      break;
    case 'export_image':
      if (origArgs?.quality !== clampArgs?.quality) {
        clampedValues.push(`quality clamped from ${origArgs.quality} to ${clampArgs.quality}`);
      }
      break;
  }
  
  return clampedValues;
}