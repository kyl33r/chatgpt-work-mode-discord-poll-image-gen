export interface ClipboardImageSource {
  getChangeCount(): Promise<number>;
  readSingleImage(previousChangeCount: number): Promise<{
    observedChangeCount: number;
    pngBytes: Uint8Array;
  }>;
}
