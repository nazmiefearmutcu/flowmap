// Ambient types for the TC39 "JSON.parse source access" / JSON.rawJSON proposal.
// Shipped in V8 12.1 (Node 21+, modern browsers) but not yet declared by the
// ES2022 lib this project targets. The encoder uses JSON.rawJSON to emit bigint
// nanosecond fields as bare integer literals (no precision loss, no quoting).
interface JSON {
  /** Wrap pre-serialized JSON text so JSON.stringify emits it verbatim. */
  rawJSON(text: string): string;
}
