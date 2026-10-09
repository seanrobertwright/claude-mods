// A reader for the YAML Archon's workflows are written in: block mappings and
// sequences, flow `[a, b]` and `{a: 1}`, quoted and plain scalars, and `|` and
// `>` block scalars. Enough for a workflow's nodes; anchors, tags and
// multi-document files are not read. The mod ships no dependencies (ADR-0001).

type Line = { indent: number; text: string }

/** A line with its comment cut off: a `#` at the start or after a space, outside quotes. */
function uncomment(text: string): string {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== '') {
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"') i++
    } else if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s:[{,-]/.test(text[i - 1]!)) quote = ch
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i).trimEnd()
    }
  }
  return text.trimEnd()
}

/** The index of `: ` (or a final `:`) that ends a mapping key, outside quotes and brackets; -1 for none. */
function keyEnd(text: string): number {
  let quote = ''
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== '') {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ':' && depth === 0 && (i === text.length - 1 || text[i + 1] === ' ')) return i
  }
  return -1
}

function unquote(text: string): string {
  if (text.startsWith('"')) {
    return text.slice(1, -1).replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch))
  }
  return text.slice(1, -1).replace(/''/g, "'")
}

/** Splits the inside of a flow collection on its top-level commas. */
function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let quote = ''
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (quote !== '') {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i))
      start = i + 1
    }
  }
  parts.push(inner.slice(start))
  return parts.map(part => part.trim()).filter(part => part !== '')
}

function scalar(text: string): unknown {
  const value = text.trim()
  if (value === '' || value === '~' || value === 'null') return null
  if (value.startsWith('[') && value.endsWith(']')) return splitFlow(value.slice(1, -1)).map(scalar)
  if (value.startsWith('{') && value.endsWith('}')) {
    const object: Record<string, unknown> = {}
    for (const part of splitFlow(value.slice(1, -1))) {
      const at = keyEnd(part)
      if (at < 0) continue
      object[String(scalar(part.slice(0, at)))] = scalar(part.slice(at + 1))
    }
    return object
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return unquote(value)
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

class Reader {
  private at = 0
  constructor(private readonly lines: Line[], private readonly raw: string[]) {}

  /** The block that starts at the current line and is indented at least `indent`. */
  block(indent: number): unknown {
    const line = this.lines[this.at]
    if (line === undefined || line.indent < indent) return null
    return line.text.startsWith('- ') || line.text === '-' ? this.sequence(line.indent) : this.mapping(line.indent)
  }

  private sequence(indent: number): unknown[] {
    const items: unknown[] = []
    for (let line = this.lines[this.at]; line !== undefined && line.indent === indent && (line.text.startsWith('- ') || line.text === '-'); line = this.lines[this.at]) {
      const rest = line.text === '-' ? '' : line.text.slice(2)
      if (rest.trim() === '') {
        this.at++
        items.push(this.block(indent + 1))
        continue
      }
      // `- key: value` opens a mapping whose keys sit two columns in.
      if (keyEnd(rest) >= 0 && !rest.startsWith('{') && !rest.startsWith('[')) {
        this.lines[this.at] = { indent: indent + 2, text: rest }
        items.push(this.mapping(indent + 2))
        continue
      }
      this.at++
      items.push(scalar(rest))
    }
    return items
  }

  private mapping(indent: number): Record<string, unknown> {
    const object: Record<string, unknown> = {}
    for (let line = this.lines[this.at]; line !== undefined && line.indent === indent; line = this.lines[this.at]) {
      const at = keyEnd(line.text)
      if (at < 0 || line.text.startsWith('- ')) break
      const key = String(scalar(line.text.slice(0, at)))
      const rest = line.text.slice(at + 1).trim()
      this.at++
      if (/^[|>][+-]?$/.test(rest)) object[key] = this.blockScalar(indent, rest)
      else if (rest !== '') object[key] = scalar(rest)
      else {
        const next = this.lines[this.at]
        // A sequence may sit at the key's own indent.
        object[key] = next !== undefined && (next.indent > indent || (next.indent === indent && next.text.startsWith('- '))) ? this.block(next.indent) : null
      }
    }
    return object
  }

  /** A `|` or `>` scalar: the lines indented past `indent`, kept or folded. */
  private blockScalar(indent: number, style: string): string {
    const kept: string[] = []
    let inner = -1
    for (let line = this.lines[this.at]; line !== undefined && line.indent > indent; line = this.lines[this.at]) {
      if (inner < 0) inner = line.indent
      kept.push(this.raw[this.at]!.slice(inner))
      this.at++
    }
    const text = style.startsWith('|') ? kept.join('\n') : kept.join(' ')
    return style.endsWith('-') ? text : `${text}\n`
  }
}

/** Reads a YAML document; null when it holds nothing. */
export function parseYaml(source: string): unknown {
  const lines: Line[] = []
  const raw: string[] = []
  const all = source.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < all.length; i++) {
    const original = all[i]!
    // Block scalars keep their text whole, comments and all, so only the line's indent is read here.
    const text = uncomment(original)
    if (text.trim() === '' || text.trim() === '---') continue
    lines.push({ indent: original.length - original.trimStart().length, text: text.trim() })
    raw.push(original)
  }
  return new Reader(lines, raw).block(0)
}
