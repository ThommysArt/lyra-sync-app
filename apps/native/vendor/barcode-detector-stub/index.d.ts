export class BarcodeDetector {
  static getSupportedFormats(): Promise<string[]>;
  detect(source: unknown): Promise<unknown[]>;
}
