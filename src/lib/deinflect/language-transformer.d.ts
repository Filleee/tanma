export class LanguageTransformer {
  addDescriptor(descriptor: unknown): void;
  transform(sourceText: string): { text: string; conditions: number; trace: unknown[] }[];
}
