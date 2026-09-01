export interface ImageGenerationInput {
  prompt: string;
  baseImagePath: string;
  contextImagePaths: readonly string[];
}

export type ImageGenerationResult =
  | { kind: "succeeded"; bytes: Buffer; mediaType: string }
  | { kind: "refused" }
  | { kind: "failed" };

export interface ImageGenerator {
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}
