import { Token, tokenize } from "./java-tokenizer";

/**
 * A lightweight, error-tolerant Java declaration parser.
 *
 * It only extracts what Spring analysis needs — types, annotations, fields, constructors,
 * methods and their parameters — and skips method bodies and initializers wholesale.
 */

export type JavaAnnotation = {
  name: string;
  /** Attribute values; positional values are stored under "value". Non-literal expressions are wrapped in braces, e.g. "{RequestMethod.GET}". */
  values: Map<string, string[]>;
  line: number;
};

export type JavaTypeRef = {
  /** Simple name of the base type, e.g. "List" for java.util.List<Foo>. */
  name: string;
  args: JavaTypeRef[];
  array: boolean;
  text: string;
};

export type JavaParam = {
  name: string;
  type: JavaTypeRef;
  annotations: JavaAnnotation[];
};

export type JavaField = {
  name: string;
  type: JavaTypeRef;
  annotations: JavaAnnotation[];
  modifiers: string[];
  hasInitializer: boolean;
  /** Initializer of a string constant, e.g. "/api" or "{Base.PATH}/users"; undefined for any other initializer. */
  constantValue?: string;
  line: number;
};

export type JavaMethod = {
  name: string;
  returnType: JavaTypeRef | null;
  params: JavaParam[];
  annotations: JavaAnnotation[];
  modifiers: string[];
  isConstructor: boolean;
  line: number;
};

export type JavaTypeKind = "class" | "interface" | "enum" | "record" | "annotation";

export type JavaType = {
  kind: JavaTypeKind;
  name: string;
  annotations: JavaAnnotation[];
  modifiers: string[];
  extends: JavaTypeRef[];
  implements: JavaTypeRef[];
  recordComponents: JavaParam[];
  fields: JavaField[];
  methods: JavaMethod[];
  nested: JavaType[];
  line: number;
};

export type JavaFile = {
  file: string;
  packageName: string;
  imports: string[];
  types: JavaType[];
};

const MODIFIERS = new Set([
  "public", "protected", "private", "static", "final", "abstract", "native",
  "synchronized", "transient", "volatile", "strictfp", "default", "sealed",
]);
const OPENERS = new Set(["(", "{", "["]);
const CLOSERS = new Set([")", "}", "]"]);

export function parseJava(source: string, file = ""): JavaFile {
  return new JavaParser(tokenize(source)).parseFile(file);
}

/** Strips the braces wrapping a non-literal annotation value: "{RequestMethod.GET}" -> "RequestMethod.GET". */
export function unwrapValue(value: string): string {
  return value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
}

class JavaParser {
  private i = 0;

  constructor(private readonly t: Token[]) {}

  parseFile(file: string): JavaFile {
    let packageName = "";
    const imports: string[] = [];
    const types: JavaType[] = [];

    while (this.i < this.t.length) {
      if (this.is("@") && !this.is("interface", 1)) {
        // Package annotations (package-info.java) precede "package"; otherwise they belong to the first type.
        const start = this.i;
        while (this.is("@") && !this.is("interface", 1)) this.parseAnnotation();
        if (!this.is("package")) {
          this.i = start;
          break;
        }
      } else if (this.is("package")) {
        this.i++;
        packageName = this.readQualifiedName();
      } else if (this.is("import")) {
        this.i++;
        if (this.is("static")) this.i++;
        imports.push(this.readQualifiedName());
      } else {
        break;
      }
    }

    this.parseMembers(null, types);
    return { file, packageName, imports, types };
  }

  // ------------------------------------------------------------------ token helpers

  private is(value: string, offset = 0): boolean {
    const tok = this.t[this.i + offset];
    return !!tok && (tok.kind === "symbol" || tok.kind === "ident") && tok.value === value;
  }

  private isIdent(offset = 0): boolean {
    return this.t[this.i + offset]?.kind === "ident";
  }

  private isOpener(offset = 0): boolean {
    const tok = this.t[this.i + offset];
    return !!tok && tok.kind === "symbol" && OPENERS.has(tok.value);
  }

  private isCloser(offset = 0): boolean {
    const tok = this.t[this.i + offset];
    return !!tok && tok.kind === "symbol" && CLOSERS.has(tok.value);
  }

  /** Index of the bracket closing the one at `start`. */
  private matchIndex(start: number): number {
    let depth = 0;
    for (let j = start; j < this.t.length; j++) {
      const tok = this.t[j];
      if (tok.kind !== "symbol") continue;
      if (OPENERS.has(tok.value)) depth++;
      else if (CLOSERS.has(tok.value) && --depth === 0) return j;
    }
    return this.t.length - 1;
  }

  private skipBalanced(): void {
    this.i = this.matchIndex(this.i) + 1;
  }

  private skipAngles(): void {
    let depth = 0;
    while (this.i < this.t.length) {
      if (this.is("<")) depth++;
      else if (this.is(">") && --depth === 0) {
        this.i++;
        return;
      } else if (this.is("{") || this.is(";")) {
        return; // malformed: never run past a body
      }
      this.i++;
    }
  }

  /** Skips to the end of a statement: consumes the ";" but stops before an unmatched "}". */
  private skipStatement(): void {
    while (this.i < this.t.length) {
      if (this.is(";")) {
        this.i++;
        return;
      }
      if (this.isCloser()) return;
      if (this.isOpener()) this.skipBalanced();
      else this.i++;
    }
  }

  /** "a.b.C;" or "a.b.*;" -> "a.b.C" */
  private readQualifiedName(): string {
    let name = "";
    while (this.i < this.t.length && !this.is(";")) {
      name += this.t[this.i++].value;
    }
    this.i++;
    return name;
  }

  // ------------------------------------------------------------------ declarations

  private isTypeDeclStart(): boolean {
    const v = this.t[this.i].value;
    if (v === "class" || v === "interface" || v === "enum") return this.isIdent(1);
    if (v === "record") return this.isIdent(1) && (this.is("(", 2) || this.is("<", 2));
    return false;
  }

  /** Parses type members (or top-level declarations when `owner` is null) until the closing "}". */
  private parseMembers(owner: JavaType | null, out: JavaType[]): void {
    let annotations: JavaAnnotation[] = [];
    let modifiers: string[] = [];
    const reset = () => {
      annotations = [];
      modifiers = [];
    };

    while (this.i < this.t.length) {
      const tok = this.t[this.i];
      if (tok.kind === "string" || tok.kind === "char" || tok.kind === "number") {
        this.i++;
        continue;
      }
      const v = tok.value;

      if (v === "}") {
        this.i++;
        if (owner) return;
        reset();
        continue;
      }
      if (v === ";") {
        this.i++;
        reset();
        continue;
      }
      if (v === "@") {
        if (this.is("interface", 1)) {
          this.i++;
          out.push(this.parseTypeDecl("annotation", annotations, modifiers));
          reset();
        } else {
          annotations.push(this.parseAnnotation());
        }
        continue;
      }
      if (tok.kind === "ident" && MODIFIERS.has(v)) {
        modifiers.push(v);
        this.i++;
        continue;
      }
      if (v === "non" && this.is("-", 1) && this.is("sealed", 2)) {
        this.i += 3;
        continue;
      }
      if (v === "{") {
        this.skipBalanced(); // initializer block
        reset();
        continue;
      }
      if (tok.kind === "ident" && this.isTypeDeclStart()) {
        out.push(this.parseTypeDecl(null, annotations, modifiers));
        reset();
        continue;
      }
      if (!owner) {
        this.i++;
        continue;
      }
      if (v === "<") {
        this.skipAngles(); // generic method type parameters
        continue;
      }
      if (tok.kind === "ident") {
        this.parseMember(owner, annotations, modifiers);
        reset();
        continue;
      }
      this.i++;
    }
  }

  private parseTypeDecl(kindOverride: JavaTypeKind | null, annotations: JavaAnnotation[], modifiers: string[]): JavaType {
    const keyword = this.t[this.i++];
    const kind = kindOverride ?? (keyword.value as JavaTypeKind);
    const nameTok = this.t[this.i++];
    const type: JavaType = {
      kind,
      name: nameTok?.value ?? "",
      annotations,
      modifiers,
      extends: [],
      implements: [],
      recordComponents: [],
      fields: [],
      methods: [],
      nested: [],
      line: keyword.line,
    };

    if (this.is("<")) this.skipAngles();
    if (kind === "record" && this.is("(")) type.recordComponents = this.parseParams();

    while (this.i < this.t.length && !this.is("{")) {
      if (this.is("extends")) {
        this.i++;
        type.extends = this.parseTypeList();
      } else if (this.is("implements")) {
        this.i++;
        type.implements = this.parseTypeList();
      } else if (this.is(";") || this.is("}")) {
        return type; // malformed
      } else {
        this.i++; // permits …
      }
    }
    this.i++; // {

    if (kind === "enum") this.skipEnumConstants();
    this.parseMembers(type, type.nested);
    return type;
  }

  private skipEnumConstants(): void {
    while (this.i < this.t.length) {
      if (this.is(";")) {
        this.i++;
        return;
      }
      if (this.is("}")) return;
      if (this.isOpener()) this.skipBalanced();
      else this.i++;
    }
  }

  private parseMember(owner: JavaType, annotations: JavaAnnotation[], modifiers: string[]): void {
    const first = this.t[this.i];
    const line = first.line;

    // Constructor: Name(…)
    if (first.value === owner.name && this.is("(", 1)) {
      this.i++;
      const params = this.parseParams();
      this.skipMethodRest();
      owner.methods.push({ name: owner.name, returnType: null, params, annotations, modifiers, isConstructor: true, line });
      return;
    }

    // Compact record constructor: Name { … }
    if (owner.kind === "record" && first.value === owner.name && this.is("{", 1)) {
      this.i++;
      this.skipBalanced();
      return;
    }

    const type = this.parseType();
    if (!type) {
      this.i++;
      return;
    }
    if (!this.isIdent()) {
      this.skipStatement();
      return;
    }
    let nameTok = this.t[this.i++];

    if (this.is("(")) {
      const params = this.parseParams();
      this.skipMethodRest();
      owner.methods.push({ name: nameTok.value, returnType: type, params, annotations, modifiers, isConstructor: false, line });
      return;
    }

    // Field declarators: int a, b = 2;
    for (;;) {
      while (this.is("[") && this.is("]", 1)) this.i += 2;
      let hasInitializer = false;
      let constantValue: string | undefined;
      if (this.is("=")) {
        hasInitializer = true;
        const start = this.i + 1;
        this.skipInitializer();
        const init = this.t.slice(start, this.i);
        const isStringExpr = init.some(t => t.kind === "string")
          && init.every(t => t.kind === "string" || t.kind === "ident" || t.value === "+" || t.value === ".");
        if (type.name === "String" && isStringExpr) constantValue = elementValue(init);
      }
      owner.fields.push({ name: nameTok.value, type, annotations, modifiers, hasInitializer, constantValue, line: nameTok.line });
      if (this.is(",") && this.isIdent(1)) {
        this.i++;
        nameTok = this.t[this.i++];
        continue;
      }
      break;
    }
    if (this.is(";")) this.i++;
  }

  /** Skips "= expr" up to (not including) the next top-level "," or ";". */
  private skipInitializer(): void {
    this.i++; // =
    while (this.i < this.t.length) {
      if (this.is(",") || this.is(";") || this.is("}")) return;
      if (this.is("new") && this.isIdent(1)) {
        this.i++;
        this.parseType(); // consumes generic arguments such as HashMap<String, Foo>
        continue;
      }
      if (this.isOpener()) this.skipBalanced();
      else this.i++;
    }
  }

  /** After a method's ")" — skips throws clauses, default values and the body. */
  private skipMethodRest(): void {
    while (this.i < this.t.length) {
      if (this.is("{")) {
        this.skipBalanced();
        return;
      }
      if (this.is(";")) {
        this.i++;
        return;
      }
      if (this.is("default")) {
        this.skipStatement();
        return;
      }
      if (this.is("}")) return;
      this.i++;
    }
  }

  private parseParams(): JavaParam[] {
    const end = this.matchIndex(this.i);
    this.i++; // (
    const params: JavaParam[] = [];

    while (this.i < end) {
      const annotations: JavaAnnotation[] = [];
      while (this.is("@") || this.is("final")) {
        if (this.is("final")) this.i++;
        else annotations.push(this.parseAnnotation());
      }
      const type = this.parseType();
      if (type && this.isIdent()) {
        const name = this.t[this.i++].value;
        if (name !== "this") params.push({ name, type, annotations });
      }
      while (this.i < end && !this.is(",")) {
        if (this.isOpener()) this.skipBalanced();
        else this.i++;
      }
      if (this.is(",")) this.i++;
    }

    this.i = end + 1;
    return params;
  }

  private parseTypeList(): JavaTypeRef[] {
    const list: JavaTypeRef[] = [];
    while (this.i < this.t.length) {
      const type = this.parseType();
      if (type) list.push(type);
      if (this.is(",")) {
        this.i++;
        continue;
      }
      break;
    }
    return list;
  }

  private parseType(): JavaTypeRef | null {
    while (this.is("@") && !this.is("interface", 1)) this.parseAnnotation();

    if (this.is("?")) {
      this.i++;
      if (this.is("extends") || this.is("super")) {
        this.i++;
        return this.parseType();
      }
      return { name: "Object", args: [], array: false, text: "?" };
    }

    if (!this.isIdent()) return null;
    const parts = [this.t[this.i++].value];
    let args: JavaTypeRef[] = [];

    for (;;) {
      if (this.is("<")) {
        args = this.parseTypeArgs();
        continue;
      }
      if (this.is(".") && this.isIdent(1)) {
        this.i++;
        parts.push(this.t[this.i++].value);
        continue;
      }
      break;
    }

    let dims = "";
    while (this.is("[") && this.is("]", 1)) {
      this.i += 2;
      dims += "[]";
    }
    if (this.is("...")) {
      this.i++;
      dims += "...";
    }

    const name = parts[parts.length - 1];
    const text = name + (args.length ? `<${args.map(a => a.text).join(", ")}>` : "") + dims;
    return { name, args, array: dims !== "", text };
  }

  private parseTypeArgs(): JavaTypeRef[] {
    this.i++; // <
    const args: JavaTypeRef[] = [];
    while (this.i < this.t.length && !this.is(">")) {
      if (this.is("{") || this.is(";") || this.is("(")) return args; // not a type argument list after all
      const before = this.i;
      const type = this.parseType();
      if (type) args.push(type);
      if (this.is(",")) this.i++;
      else if (this.i === before) this.i++;
    }
    this.i++; // >
    return args;
  }

  // ------------------------------------------------------------------ annotations

  private parseAnnotation(): JavaAnnotation {
    const line = this.t[this.i].line;
    this.i++; // @
    let name = "";
    while (this.isIdent()) {
      name = this.t[this.i++].value;
      if (this.is(".") && this.isIdent(1)) this.i++;
      else break;
    }

    const values = new Map<string, string[]>();
    if (this.is("(")) {
      const end = this.matchIndex(this.i);
      parseAnnotationValues(this.t.slice(this.i + 1, end), values);
      this.i = end + 1;
    }
    return { name, values, line };
  }
}

/** Splits tokens on commas that are not nested inside brackets. */
function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const tok of tokens) {
    if (tok.kind === "symbol") {
      if (OPENERS.has(tok.value)) depth++;
      else if (CLOSERS.has(tok.value)) depth--;
      else if (tok.value === "," && depth === 0) {
        parts.push([]);
        continue;
      }
    }
    parts[parts.length - 1].push(tok);
  }
  return parts.filter(p => p.length > 0);
}

function parseAnnotationValues(tokens: Token[], values: Map<string, string[]>): void {
  for (const part of splitTopLevel(tokens)) {
    let key = "value";
    let rest = part;
    if (part.length > 2 && part[0].kind === "ident" && part[1].value === "=" && part[2].value !== "=") {
      key = part[0].value;
      rest = part.slice(2);
    }
    // Flatten array initializers: { "a", "b" }
    const flat = rest.filter(t => !(t.kind === "symbol" && (t.value === "{" || t.value === "}")));
    const list = values.get(key) ?? [];
    for (const element of splitTopLevel(flat)) {
      const value = elementValue(element);
      if (value !== "") list.push(value);
    }
    values.set(key, list);
  }
}

/** "/api" + "/users" -> "/api/users"; Paths.API + "/x" -> "{Paths.API}/x"; RequestMethod.GET -> "{RequestMethod.GET}". */
function elementValue(tokens: Token[]): string {
  let out = "";
  let chain = "";
  const flush = () => {
    if (chain) out += `{${chain}}`;
    chain = "";
  };
  for (const tok of tokens) {
    if (tok.kind === "string") {
      flush();
      out += tok.value;
    } else if (tok.kind === "ident" || tok.kind === "number" || tok.value === ".") {
      chain += tok.value;
    } else if (tok.value === "+") {
      flush();
    }
  }
  flush();
  return out;
}
