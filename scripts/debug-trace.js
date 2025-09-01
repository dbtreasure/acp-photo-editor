#!/usr/bin/env node

/**
 * Debug helper to parse and display trace information from NDJSON logs
 * Usage: node scripts/debug-trace.js [traceId]
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

async function findLatestLog(directory = 'logs') {
  const files = await fs.promises.readdir(directory);
  const agentLogs = files
    .filter(f => f.startsWith('agent-') && f.endsWith('.ndjson'))
    .sort()
    .reverse();
  
  if (agentLogs.length === 0) {
    throw new Error('No agent log files found');
  }
  
  return path.join(directory, agentLogs[0]);
}

async function parseLogFile(filePath, targetTraceId) {
  const events = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);
      const traceId = entry.data?.traceId;
      
      // If we're looking for a specific trace, filter by it
      if (targetTraceId && traceId !== targetTraceId) {
        continue;
      }
      
      // Collect relevant events
      if (traceId || entry.data?.event) {
        events.push({
          timestamp: entry.t,
          traceId,
          event: entry.data?.event,
          data: entry.data,
        });
      }
    } catch (err) {
      // Skip malformed lines
    }
  }
  
  return events;
}

function displayTrace(events) {
  if (events.length === 0) {
    console.log('No trace events found');
    return;
  }
  
  // Group by trace ID
  const traces = {};
  events.forEach(event => {
    const traceId = event.traceId || 'unknown';
    if (!traces[traceId]) {
      traces[traceId] = [];
    }
    traces[traceId].push(event);
  });
  
  // Display each trace
  Object.entries(traces).forEach(([traceId, traceEvents]) => {
    console.log(`\n${colors.bright}${colors.cyan}═══ Trace: ${traceId} ═══${colors.reset}`);
    
    // Sort by timestamp
    traceEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Calculate relative times
    const startTime = new Date(traceEvents[0].timestamp);
    
    traceEvents.forEach(event => {
      const relativeMs = new Date(event.timestamp) - startTime;
      const timeStr = `+${relativeMs}ms`.padEnd(10);
      
      // Color code by event type
      let eventColor = colors.dim;
      let icon = '○';
      
      if (event.event?.includes('start')) {
        eventColor = colors.green;
        icon = '▶';
      } else if (event.event?.includes('error') || event.event?.includes('failed')) {
        eventColor = colors.red;
        icon = '✗';
      } else if (event.event?.includes('result') || event.event?.includes('complete')) {
        eventColor = colors.blue;
        icon = '✓';
      } else if (event.event?.includes('planner')) {
        eventColor = colors.magenta;
        icon = '🤖';
      } else if (event.event?.includes('preview') || event.event?.includes('image')) {
        eventColor = colors.yellow;
        icon = '🖼';
      }
      
      console.log(`${colors.dim}${timeStr}${colors.reset} ${icon}  ${eventColor}${event.event || 'event'}${colors.reset}`);
      
      // Display key attributes
      if (event.data) {
        const attrs = { ...event.data };
        delete attrs.event;
        delete attrs.traceId;
        
        const important = ['command', 'planner_mode', 'vision', 'latencyMs', 'calls', 'dropped', 'imageBytes'];
        important.forEach(key => {
          if (attrs[key] !== undefined) {
            console.log(`${' '.repeat(13)}${colors.dim}${key}:${colors.reset} ${attrs[key]}`);
          }
        });
      }
    });
  });
}

async function main() {
  try {
    const targetTraceId = process.argv[2];
    
    console.log(`${colors.bright}Photo Agent Trace Debugger${colors.reset}`);
    console.log('─'.repeat(50));
    
    const logFile = await findLatestLog();
    console.log(`Reading: ${logFile}`);
    
    if (targetTraceId) {
      console.log(`Filtering for trace: ${targetTraceId}`);
    }
    
    const events = await parseLogFile(logFile, targetTraceId);
    displayTrace(events);
    
    console.log(`\n${colors.dim}Found ${events.length} events${colors.reset}`);
    
    // Show available trace IDs if no specific one requested
    if (!targetTraceId) {
      const uniqueTraces = new Set(events.map(e => e.traceId).filter(Boolean));
      if (uniqueTraces.size > 1) {
        console.log(`\n${colors.yellow}Tip: Run with a specific trace ID to see only that trace:${colors.reset}`);
        uniqueTraces.forEach(id => {
          console.log(`  node scripts/debug-trace.js ${id}`);
        });
      }
    }
    
  } catch (error) {
    console.error(`${colors.red}Error: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

main();