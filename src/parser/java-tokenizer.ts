export type TokenKind = "ident" | "string" | "char" | "number" | "symbol";

export type Token = {
  kind: TokenKind;
  value: string;
  line: number;
};

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;
const isDigit = (c: string) => c >= "0" && c <= "9";

/**
 * Splits Java source into identifiers, literals and single-character symbols.
 * Comments and whitespace are dropped; string literals keep their (unescaped) content
 * so annotation values such as request paths can be read.
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  while (i < n) {
    const c = src[i];

    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i++;
      continue;
    }

    // // line comment
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    // /* block comment */
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }

    if (c === '"') {
      const startLine = line;
      let value = "";
      if (src.startsWith('"""', i)) {
        // text block
        i += 3;
        while (i < n && !src.startsWith('"""', i)) {
          if (src[i] === "\\") {
            value += src[i + 1] ?? "";
            i += 2;
            continue;
          }
          if (src[i] === "\n") line++;
          value += src[i++];
        }
        i += 3;
      } else {
        i++;
        while (i < n && src[i] !== '"' && src[i] !== "\n") {
          if (src[i] === "\\") {
            value += src[i + 1] ?? "";
            i += 2;
            continue;
          }
          value += src[i++];
        }
        i++;
      }
      tokens.push({ kind: "string", value, line: startLine });
      continue;
    }

    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'" && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      tokens.push({ kind: "char", value: "", line });
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      tokens.push({ kind: "ident", value: src.slice(i, j), line });
      i = j;
      continue;
    }

    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
      tokens.push({ kind: "number", value: src.slice(i, j), line });
      i = j;
      continue;
    }

    if (src.startsWith("...", i)) {
      tokens.push({ kind: "symbol", value: "...", line });
      i += 3;
      continue;
    }

    // Everything else is a single-character symbol. ">>" stays as two ">" so generics close cleanly.
    tokens.push({ kind: "symbol", value: c, line });
    i++;
  }

  return tokens;
}
