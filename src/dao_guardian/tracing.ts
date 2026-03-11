import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import opentelemetry, { Tracer } from "@opentelemetry/api";

let tracer: Tracer;

export function initTracing() {
  const exporter = new OTLPTraceExporter({});

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [SemanticResourceAttributes.SERVICE_NAME]: "dao-evolver",
    }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  opentelemetry.trace.setGlobalTracerProvider(provider);

  tracer = opentelemetry.trace.getTracer("dao-evolver");
  return tracer;
}

export function getTracer(): Tracer {
  if (!tracer) {
    return initTracing();
  }
  return tracer;
}
