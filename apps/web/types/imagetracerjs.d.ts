declare module "imagetracerjs" {
  type Segment =
    | { type: "L"; x1: number; y1: number; x2: number; y2: number }
    | { type: "Q"; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number };
  export type TracePath = { segments: Segment[]; isholepath: boolean; holechildren: number[] };
  export type TraceColor = { r: number; g: number; b: number; a: number };
  export type TraceData = {
    width: number;
    height: number;
    palette: TraceColor[];
    layers: TracePath[][];
  };
  const tracer: {
    imagedataToTracedata(
      image: { width: number; height: number; data: Uint8ClampedArray },
      options: Record<string, number | boolean | TraceColor[]>,
    ): TraceData;
  };
  export default tracer;
}
