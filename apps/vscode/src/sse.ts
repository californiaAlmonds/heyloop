export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];

  constructor(private readonly onData?: (data: string) => void) {}

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const emitted: string[] = [];

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      if (line === '') {
        if (this.dataLines.length > 0) {
          const data = this.dataLines.join('\n');
          this.dataLines = [];
          emitted.push(data);
          this.onData?.(data);
        }
      } else if (!line.startsWith(':')) {
        const colonIndex = line.indexOf(':');
        const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
        let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
        if (field === 'data') {
          this.dataLines.push(value);
        }
      }

      newlineIndex = this.buffer.indexOf('\n');
    }

    return emitted;
  }

  reset(): void {
    this.buffer = '';
    this.dataLines = [];
  }
}
