// The operations of a SPARQL Update request, read well enough to name the
// ones that remove statements in an approval question. The server parses
// the update; this reader only splits it at its top-level `;`, skips
// strings, IRIs and comments, and reads each operation's first keywords.

/** One operation of an update. */
export interface UpdateOperation {
  /** Its form: DELETE DATA, DELETE WHERE, DELETE/INSERT, INSERT DATA, CLEAR, … */
  form: string;
  /** Its text from its first keyword on, without its PREFIX and BASE lines. */
  text: string;
  /** Whether it can remove statements. */
  removes: boolean;
}

/** The characters an IRI reference cannot hold (SPARQL 1.1, IRIREF). */
// eslint-disable-next-line no-control-regex -- IRIREF excludes the control characters by grammar
const IRI = /^<[^<>"{}|^`\\\u0000-\u0020]*>/;

type Word = { word: string; start: number };

/** Skip a string literal at `i`; returns the index after it. */
function skipString(text: string, i: number): number {
  const quote = text[i];
  const long = text.startsWith(quote.repeat(3), i);
  let j = i + (long ? 3 : 1);
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (long ? text.startsWith(quote.repeat(3), j) : text[j] === quote) {
      return j + (long ? 3 : 1);
    }
    // A short string ends at its line.
    if (!long && (text[j] === "\n" || text[j] === "\r")) return j;
    j += 1;
  }
  return j;
}

/**
 * Split an update into its operations. Each one's top-level words (at
 * brace depth 0) give its form; the words inside `{ … }` are data or
 * patterns.
 */
export function updateOperations(update: string): UpdateOperation[] {
  const operations: UpdateOperation[] = [];
  let depth = 0;
  let words: Word[] = [];
  const finish = (end: number) => {
    const operation = classify(update, words, end);
    if (operation) operations.push(operation);
    words = [];
  };
  let i = 0;
  while (i < update.length) {
    const c = update[i];
    if (c === "#") {
      while (i < update.length && update[i] !== "\n") i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(update, i);
      continue;
    }
    if (c === "<") {
      const iri = IRI.exec(update.slice(i, i + 4_096));
      if (iri) {
        if (depth === 0) words.push({ word: iri[0], start: i });
        i += iri[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === "{") {
      // A top-level brace tells DELETE WHERE { … } from DELETE { … } WHERE.
      if (depth === 0) words.push({ word: "{", start: i });
      depth += 1;
    } else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      finish(i);
      i += 1;
      continue;
    }
    if (/[A-Za-z_:]/.test(c)) {
      let j = i + 1;
      while (j < update.length && /[A-Za-z0-9_:.-]/.test(update[j])) j += 1;
      if (depth === 0) words.push({ word: update.slice(i, j), start: i });
      i = j;
      continue;
    }
    i += 1;
  }
  finish(update.length);
  return operations;
}

/** An update form that removes statements, by its first keyword. */
const REMOVING = new Set(["DELETE", "CLEAR", "DROP", "MOVE", "COPY"]);

function classify(
  update: string,
  words: Word[],
  end: number,
): UpdateOperation | undefined {
  let k = 0;
  // The prologue: PREFIX name: <iri> and BASE <iri>.
  while (k < words.length) {
    const word = words[k].word.toUpperCase();
    if (word === "PREFIX") k += 3;
    else if (word === "BASE") k += 2;
    else break;
  }
  if (k >= words.length) return undefined;
  const begin = words[k].start;
  const text = update.slice(begin, end).trim();
  const upper = words.slice(k).map((w) => w.word.toUpperCase());
  let first = upper[0];
  let rest = upper.slice(1);
  let prefix = "";
  if (first === "WITH") {
    // WITH <iri> DELETE … or WITH <iri> INSERT …
    prefix = "WITH ";
    first = upper[2] ?? "";
    rest = upper.slice(3);
  }
  let form = `${prefix}${first}`;
  if (first === "INSERT" || first === "DELETE") {
    if (rest[0] === "DATA" || rest[0] === "WHERE") form += ` ${rest[0]}`;
    else if (first === "DELETE" && rest.includes("INSERT"))
      form = `${prefix}DELETE/INSERT`;
  } else if (first === "CLEAR" || first === "DROP") {
    form += rest[0] === "SILENT" ? ` SILENT` : "";
  }
  const removes =
    REMOVING.has(first) ||
    // An unknown form that names a removing keyword at its top level.
    (!KNOWN.has(first) && upper.some((word) => REMOVING.has(word)));
  return { form, text, removes };
}

const KNOWN = new Set([
  "INSERT",
  "DELETE",
  "LOAD",
  "CLEAR",
  "DROP",
  "CREATE",
  "ADD",
  "MOVE",
  "COPY",
]);
