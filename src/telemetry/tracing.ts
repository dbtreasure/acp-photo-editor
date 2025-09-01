import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { 
  trace, 
  context, 
  SpanStatusCode, 
  Span as OTELSpan,
  SpanKind,
  Tracer
} from '@opentelemetry/api';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

// Configuration for telemetry
export interface TelemetryConfig {
  serviceName?: string;
  jaegerEndpoint?: string;
  enabled?: boolean;
  debug?: boolean;
}

let sdk: NodeSDK | null = null;
let tracer: Tracer | null = null;

/**
 * Initialize OpenTelemetry with Jaeger exporter
 */
export function initTelemetry(config: TelemetryConfig = {}) {
  const {
    serviceName = 'photo-agent',
    jaegerEndpoint = 'http://localhost:14268/api/traces',
    enabled = process.env.OTEL_ENABLED === 'true' || process.env.JAEGER_ENABLED === 'true',
    debug = process.env.OTEL_DEBUG === 'true'
  } = config;
  
  if (!enabled) {
    console.log('[Telemetry] OpenTelemetry disabled. Set OTEL_ENABLED=true to enable.');
    return;
  }
  
  try {
    // Create Jaeger exporter
    const jaegerExporter = new JaegerExporter({
      endpoint: jaegerEndpoint,
    });
    
    // Create resource
    const customResource = resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: '7c',
      environment: process.env.NODE_ENV || 'development',
    });
    const resource = defaultResource().merge(customResource);
    
    // Initialize SDK
    sdk = new NodeSDK({
      resource,
      spanProcessor: new BatchSpanProcessor(jaegerExporter),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable fs instrumentation to reduce noise
          '@opentelemetry/instrumentation-fs': {
            enabled: false,
          },
        }),
      ],
    });
    
    // Start the SDK
    sdk.start();
    
    // Get tracer
    tracer = trace.getTracer(serviceName, '1.0.0');
    
    if (debug) {
      console.log(`[Telemetry] OpenTelemetry initialized with Jaeger exporter at ${jaegerEndpoint}`);
    }
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
      sdk?.shutdown()
        .then(() => console.log('[Telemetry] OpenTelemetry terminated'))
        .catch((error) => console.error('[Telemetry] Error terminating OpenTelemetry', error));
    });
  } catch (error) {
    console.error('[Telemetry] Failed to initialize OpenTelemetry:', error);
  }
}

/**
 * Get the global tracer instance
 */
export function getTracer(): Tracer {
  if (!tracer) {
    // Return a no-op tracer if not initialized
    tracer = trace.getTracer('photo-agent', '1.0.0');
  }
  return tracer;
}

/**
 * Create a new span for an operation
 */
export function startSpan(
  name: string,
  attributes?: Record<string, any>,
  kind: SpanKind = SpanKind.INTERNAL
): OTELSpan {
  const tracer = getTracer();
  return tracer.startSpan(name, {
    kind,
    attributes,
  });
}

/**
 * Run a function within a span context
 */
export async function withSpan<T>(
  name: string,
  fn: (span: OTELSpan) => Promise<T>,
  attributes?: Record<string, any>
): Promise<T> {
  const span = startSpan(name, attributes);
  
  try {
    // Run the function within the span context
    const result = await context.with(
      trace.setSpan(context.active(), span),
      () => fn(span)
    );
    
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error: any) {
    // Record the error
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Add attributes to the current span
 */
export function addSpanAttributes(attributes: Record<string, any>) {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttributes(attributes);
  }
}

/**
 * Add an event to the current span
 */
export function addSpanEvent(name: string, attributes?: Record<string, any>) {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

/**
 * Get the current trace ID
 */
export function getTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (span) {
    const spanContext = span.spanContext();
    return spanContext.traceId;
  }
  return undefined;
}

/**
 * Shutdown telemetry
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    console.log('[Telemetry] OpenTelemetry shut down successfully');
  }
}