#!/usr/bin/env node
/**
 * Contract guard — `openapi.yaml` (source of truth) vs declarations in `frontend/src`.
 *
 * Issue #24. The frontend types are hand-written on purpose (no `openapi-typescript`,
 * no codegen step in F4), so this guard is the proof that they still match the frozen
 * contract. It is offline, has no new dependency and runs anywhere Node runs:
 *
 *   node frontend/scripts/check-contract.mjs
 *   node frontend/scripts/check-contract.mjs --openapi openapi.yaml --frontend frontend
 *
 * It uses the `typescript` devDependency already installed in `frontend/` to read the
 * *declared* types (regex on source text would silently pass). The YAML side is read by
 * a deliberately small subset reader: block mappings, block sequences, quoted/plain
 * scalars, and anchors/aliases (`&a5` / `*a5` — the file really uses them).
 *
 * Rules:
 *   - a block missing from `openapi.yaml` is FATAL: the guard never passes green by omission;
 *   - a divergence in `frontend/src` is reported with the offending file and field;
 *   - exit 0 only when every group matches.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_FRONTEND = path.resolve(HERE, "..");
const DEFAULT_OPENAPI = path.join(REPO_ROOT, "openapi.yaml");

const TYPES_LABEL = "frontend/src/types.ts";
const API_LABEL = "frontend/src/api.ts";

/** Raised when `openapi.yaml` (or the frontend sources) cannot be read the way the guard needs. */
class ContractError extends Error {}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { openapi: DEFAULT_OPENAPI, frontend: DEFAULT_FRONTEND, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--openapi") {
      i += 1;
      out.openapi = path.resolve(argv[i] ?? "");
    } else if (arg === "--frontend") {
      i += 1;
      out.frontend = path.resolve(argv[i] ?? "");
    } else {
      throw new ContractError(`check-contract.mjs: unknown argument "${arg}" (use --help)`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal YAML subset reader
//
// Not a YAML implementation: it understands exactly the shapes this contract uses,
// and it throws (never guesses) when it meets anything else.
// ---------------------------------------------------------------------------

const isContent = (text) => text.trim() !== "" && !text.trim().startsWith("#");

/** Keys whose values are free text: they absorb every deeper line (wrapped descriptions). */
const FREE_TEXT_KEYS = new Set(["description", "summary", "example"]);

function unquote(text) {
  const value = text.trim();
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

function coerce(text) {
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  return text;
}

class YamlSubsetReader {
  constructor(text) {
    this.lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    this.pos = 0;
    this.anchors = new Map();
  }

  static indentOf(text) {
    return /^[ ]*/.exec(text)[0].length;
  }

  static looksLikeKey(text) {
    return /^[^\s:][^:]*:(\s|$)/.test(text);
  }

  parse() {
    this.skipBlank();
    if (this.pos >= this.lines.length) return null;
    const value = this.parseNode(YamlSubsetReader.indentOf(this.lines[this.pos]));
    this.skipBlank();
    if (this.pos < this.lines.length) {
      throw new ContractError(`openapi.yaml:${this.pos + 1}: unexpected content after the document root`);
    }
    return value;
  }

  skipBlank() {
    while (this.pos < this.lines.length && !isContent(this.lines[this.pos])) this.pos += 1;
  }

  parseNode(indent) {
    this.skipBlank();
    const content = this.lines[this.pos].slice(indent).trimEnd();
    if (content === "-" || content.startsWith("- ")) return this.parseSequence(indent);
    return this.parseMapping(indent);
  }

  parseChildOrNull(indent) {
    this.skipBlank();
    if (this.pos < this.lines.length && YamlSubsetReader.indentOf(this.lines[this.pos]) > indent) {
      return this.parseNode(YamlSubsetReader.indentOf(this.lines[this.pos]));
    }
    return null;
  }

  parseMapping(indent) {
    const node = {};
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.lines.length) break;
      const raw = this.lines[this.pos];
      const current = YamlSubsetReader.indentOf(raw);
      if (current < indent) break;
      if (current > indent) {
        throw new ContractError(`openapi.yaml:${this.pos + 1}: unexpected indentation inside a mapping`);
      }
      const content = raw.slice(current).trimEnd();
      if (content === "-" || content.startsWith("- ")) break;
      const { key, rest, lineNo, absorb } = this.readEntry(content);
      this.pos += 1;
      node[key] =
        rest === "" || rest.startsWith("&") || rest.startsWith("*")
          ? this.readValue(rest, current, lineNo)
          : this.readScalar(rest, current, lineNo, absorb);
    }
    return node;
  }

  parseSequence(indent) {
    const items = [];
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.lines.length) break;
      const raw = this.lines[this.pos];
      const current = YamlSubsetReader.indentOf(raw);
      if (current < indent) break;
      if (current > indent) {
        throw new ContractError(`openapi.yaml:${this.pos + 1}: unexpected indentation inside a sequence`);
      }
      const content = raw.slice(current).trimEnd();
      if (!(content === "-" || content.startsWith("- "))) break;
      const lineNo = this.pos + 1;
      const afterDash = content.slice(1);
      const rest = afterDash.trim();
      if (rest === "") {
        this.pos += 1;
        items.push(this.parseChildOrNull(current));
        continue;
      }
      if (rest.startsWith("&") || rest.startsWith("*")) {
        this.pos += 1;
        items.push(this.readValue(rest, current, lineNo));
        continue;
      }
      if (YamlSubsetReader.looksLikeKey(rest)) {
        // `- name: page_size` + deeper keys: rewrite the line as a mapping entry and parse it.
        const itemIndent = current + 1 + (afterDash.length - afterDash.trimStart().length);
        this.lines[this.pos] = `${" ".repeat(itemIndent)}${rest}`;
        items.push(this.parseMapping(itemIndent));
        continue;
      }
      this.pos += 1;
      items.push(this.readScalar(rest, current, lineNo, false));
    }
    return items;
  }

  readEntry(content) {
    let quote = null;
    for (let i = 0; i < content.length; i += 1) {
      const ch = content[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ":" && (i + 1 === content.length || content[i + 1] === " ")) {
        const key = unquote(content.slice(0, i));
        return {
          key,
          rest: content.slice(i + 1).trim(),
          lineNo: this.pos + 1,
          absorb: FREE_TEXT_KEYS.has(key),
        };
      }
    }
    throw new ContractError(`openapi.yaml:${this.pos + 1}: expected "key: value", got "${content}"`);
  }

  readValue(rest, indent, lineNo) {
    if (rest === "") return this.parseChildOrNull(indent);
    if (rest.startsWith("&")) {
      const match = /^&(\S+)\s*(.*)$/.exec(rest);
      const anchor = match[1];
      const tail = match[2].trim();
      const value = tail === "" ? this.parseChildOrNull(indent) : this.readScalar(tail, indent, lineNo, false);
      this.anchors.set(anchor, value);
      return value;
    }
    if (rest.startsWith("*")) {
      const alias = rest.slice(1).trim();
      if (!this.anchors.has(alias)) {
        throw new ContractError(
          `openapi.yaml:${lineNo}: alias *${alias} has no anchor &${alias} defined before it (anchor order matters)`,
        );
      }
      return this.anchors.get(alias);
    }
    return this.readScalar(rest, indent, lineNo, false);
  }

  readScalar(rest, indent, lineNo, absorbAll) {
    const opening = rest[0];
    if (opening === '"' || opening === "'") {
      let text = rest;
      let guard = 0;
      while (!text.trimEnd().endsWith(opening) || text.trimEnd().length < 2) {
        if (this.pos >= this.lines.length) {
          throw new ContractError(`openapi.yaml:${lineNo}: unterminated quoted scalar`);
        }
        text += ` ${this.lines[this.pos].trim()}`;
        this.pos += 1;
        guard += 1;
        if (guard > 500) throw new ContractError(`openapi.yaml:${lineNo}: quoted scalar never closed`);
      }
      return unquote(text);
    }
    if (/^[|>][+-]?$/.test(rest)) {
      const parts = [];
      while (this.pos < this.lines.length && YamlSubsetReader.indentOf(this.lines[this.pos]) > indent) {
        parts.push(this.lines[this.pos].trim());
        this.pos += 1;
      }
      return parts.join("\n");
    }
    let text = rest;
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.lines.length) break;
      const raw = this.lines[this.pos];
      if (YamlSubsetReader.indentOf(raw) <= indent) break;
      const line = raw.trim();
      if (!absorbAll && (YamlSubsetReader.looksLikeKey(line) || line === "-" || line.startsWith("- "))) break;
      text += ` ${line}`;
      this.pos += 1;
    }
    return coerce(text);
  }
}

// ---------------------------------------------------------------------------
// Contract accessors — every miss is fatal, with the block named.
// ---------------------------------------------------------------------------

function dig(node, keys, where) {
  let current = node;
  for (const key of keys) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
      throw new ContractError(`openapi.yaml: ${where} not found — refusing to pass green by omission`);
    }
    current = current[key];
  }
  return current;
}

function buildContract(yamlText) {
  const root = new YamlSubsetReader(yamlText).parse();
  const schemas = dig(root, ["components", "schemas"], "components.schemas");
  const paths = dig(root, ["paths"], "paths");

  const schema = (name) => {
    const node = schemas[name];
    if (node === null || typeof node !== "object") {
      throw new ContractError(`openapi.yaml: components.schemas.${name} not found — refusing to pass green by omission`);
    }
    return node;
  };

  const prop = (schemaName, field) => {
    const properties = schema(schemaName).properties;
    if (properties === null || typeof properties !== "object" || !(field in properties)) {
      throw new ContractError(
        `openapi.yaml: components.schemas.${schemaName}.properties.${field} not found — refusing to pass green by omission`,
      );
    }
    return properties[field];
  };

  const required = (schemaName) => {
    const list = schema(schemaName).required;
    if (!Array.isArray(list)) {
      throw new ContractError(
        `openapi.yaml: components.schemas.${schemaName}.required is missing — refusing to pass green by omission`,
      );
    }
    return list.map(String);
  };

  const enumOf = (schemaName, field) => {
    const values = prop(schemaName, field).enum;
    if (!Array.isArray(values)) {
      throw new ContractError(
        `openapi.yaml: components.schemas.${schemaName}.properties.${field}.enum is missing — refusing to pass green by omission`,
      );
    }
    return values.map(String);
  };

  const operation = (pathKey, method) => {
    const item = paths[pathKey];
    if (item === null || typeof item !== "object") {
      throw new ContractError(`openapi.yaml: paths.${pathKey} not found — refusing to pass green by omission`);
    }
    const op = item[method];
    if (op === null || typeof op !== "object") {
      throw new ContractError(`openapi.yaml: paths.${pathKey}.${method} not found — refusing to pass green by omission`);
    }
    return op;
  };

  const queryParam = (pathKey, method, name) => {
    const params = operation(pathKey, method).parameters;
    if (!Array.isArray(params)) {
      throw new ContractError(
        `openapi.yaml: paths.${pathKey}.${method}.parameters is missing — refusing to pass green by omission`,
      );
    }
    const found = params.find((p) => p && p.name === name && p.in === "query");
    if (!found) {
      throw new ContractError(
        `openapi.yaml: paths.${pathKey}.${method} has no query parameter "${name}" — refusing to pass green by omission`,
      );
    }
    return found;
  };

  const responseSchema = (pathKey, method, status) => {
    const responses = operation(pathKey, method).responses;
    if (responses === null || typeof responses !== "object" || !(status in responses)) {
      throw new ContractError(
        `openapi.yaml: paths.${pathKey}.${method}.responses.${status} not found — refusing to pass green by omission`,
      );
    }
    return responses[status];
  };

  return { schemas, paths, schema, prop, required, enumOf, operation, queryParam, responseSchema };
}

// ---------------------------------------------------------------------------
// TypeScript side — read what `types.ts` / `api.ts` DECLARE, through the checker.
// ---------------------------------------------------------------------------

function factsOf(checker, type) {
  const facts = {
    typeText: checker.typeToString(type),
    literals: [],
    hasNull: false,
    hasUndefined: false,
    isString: false,
    isNumber: false,
    isBoolean: false,
  };
  const parts = type.isUnion() ? type.types : [type];
  for (const part of parts) {
    if (part.flags & ts.TypeFlags.StringLiteral) facts.literals.push(part.value);
    else if (part.flags & ts.TypeFlags.Null) facts.hasNull = true;
    else if (part.flags & ts.TypeFlags.Undefined) facts.hasUndefined = true;
    else if (part.flags & ts.TypeFlags.String) facts.isString = true;
    else if (part.flags & ts.TypeFlags.Number) facts.isNumber = true;
    else if (part.flags & ts.TypeFlags.Boolean) facts.isBoolean = true;
  }
  return facts;
}

function buildModel(frontendDir) {
  const configPath = ts.findConfigFile(frontendDir, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new ContractError(`frontend/tsconfig.json not found under ${frontendDir} — cannot read the declared types`);
  }
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new ContractError(
      `frontend/tsconfig.json is not readable: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, frontendDir);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
  const checker = program.getTypeChecker();

  const typesPath = path.join(frontendDir, "src", "types.ts");
  const apiPath = path.join(frontendDir, "src", "api.ts");
  const sourceFiles = program.getSourceFiles();
  const typesSf = sourceFiles.find((sf) => path.resolve(sf.fileName) === path.resolve(typesPath));
  const apiSf = sourceFiles.find((sf) => path.resolve(sf.fileName) === path.resolve(apiPath));
  if (!typesSf) throw new ContractError(`${TYPES_LABEL} is not part of frontend/tsconfig.json (include: ["src"])`);
  if (!apiSf) throw new ContractError(`${API_LABEL} is not part of frontend/tsconfig.json (include: ["src"])`);

  const exportCache = new Map();
  const exportsOf = (sf) => {
    if (!exportCache.has(sf.fileName)) {
      const symbols = new Map();
      const moduleSymbol = checker.getSymbolAtLocation(sf);
      if (moduleSymbol) {
        for (const symbol of checker.getExportsOfModule(moduleSymbol)) symbols.set(symbol.getName(), symbol);
      }
      exportCache.set(sf.fileName, symbols);
    }
    return exportCache.get(sf.fileName);
  };

  const resolveAlias = (symbol) =>
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

  const sourceFor = (fileKey) => (fileKey === "api.ts" ? apiSf : typesSf);

  /** Facts of `interface.<field>` as declared in the given module. */
  const prop = (fileKey, interfaceName, field) => {
    const sf = sourceFor(fileKey);
    const symbol = resolveAlias(exportsOf(sf).get(interfaceName));
    if (!symbol) return { ifaceMissing: true };
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    const propSymbol = checker.getPropertyOfType(declared, field);
    if (!propSymbol) return { missing: true, ifaceTypeText: checker.typeToString(declared) };
    const declaration = propSymbol.valueDeclaration ?? propSymbol.getDeclarations()?.[0] ?? sf;
    const type = checker.getTypeOfSymbolAtLocation(propSymbol, declaration);
    return { ...factsOf(checker, type), optional: (propSymbol.flags & ts.SymbolFlags.Optional) !== 0 };
  };

  /** Facts of an exported type alias (`LlmStatus`, `SecurityStatus`, …). */
  const aliasFacts = (name) => {
    const symbol = resolveAlias(exportsOf(typesSf).get(name));
    if (!symbol) return null;
    return factsOf(checker, checker.getDeclaredTypeOfSymbol(symbol));
  };

  /** Numeric value of an exported `const`, when it is a literal. */
  const constValue = (name) => {
    const symbol = resolveAlias(exportsOf(typesSf).get(name));
    if (!symbol) return { missing: true };
    const declaration = symbol.valueDeclaration ?? symbol.getDeclarations()?.[0] ?? typesSf;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    if (type.flags & ts.TypeFlags.NumberLiteral) return { value: type.value };
    return { nonLiteral: checker.typeToString(type) };
  };

  /** Resolved return type of an exported function plus its written annotation. */
  const returnOf = (fileKey, name) => {
    const sf = sourceFor(fileKey);
    const symbol = resolveAlias(exportsOf(sf).get(name));
    if (!symbol) return { missing: true };
    const declarations = symbol.getDeclarations() ?? [];
    const declaration = declarations.find((d) => d.type) ?? declarations[0] ?? sf;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const signature = type.getCallSignatures()[0];
    return {
      typeText: signature ? checker.typeToString(signature.getReturnType()) : null,
      annotationText: declaration && declaration.type ? declaration.type.getText(sf) : null,
    };
  };

  return { program, checker, typesSf, apiSf, prop, aliasFacts, constValue, returnOf };
}

// ---------------------------------------------------------------------------
// Checks — grouped by the ten divergences of issue #24 (plus guards 11/12).
// ---------------------------------------------------------------------------

function rel(absPath) {
  const relative = path.relative(REPO_ROOT, absPath);
  return relative === "" || relative.startsWith("..") ? absPath : relative.split(path.sep).join("/");
}

const sortedList = (values) => [...values].sort().join(", ");

/**
 * Where the frontend interface is not named like the contract schema. Everything else is
 * assumed to keep the schema name (`SkillSummary`, `ResultItem`, `ErrorEnvelope`, …).
 */
const SCHEMA_TO_INTERFACE = {
  LlmInfo: "Llm",
  TokenUsage: "LlmTokens",
  CategoryItem: "Category",
  CategoryListResponse: "CategoriesResponse",
};

const interfaceFor = (schemaName) => SCHEMA_TO_INTERFACE[schemaName] ?? schemaName;

function runChecks({ contract, model, apiText }) {
  const failures = [];
  const add = (group, message) => failures.push({ group, message });

  const isOpsInternal = (item) =>
    Object.values(item).some((op) => op && typeof op === "object" && op["x-internal"] === true);
  const totalEndpoints = Object.keys(contract.paths).length;
  const publicEndpoints = Object.values(contract.paths).filter((item) => !isOpsInternal(item)).length;
  const endpointSummary = `${totalEndpoints} endpoints, ${publicEndpoints} of them public (x-internal stays out of the browser)`;

  /** Nullability as declared on both sides; `base` is the non-null type the contract uses. */
  const nullability = (group, schemaName, field, { iface = interfaceFor(schemaName), sourceFile = TYPES_LABEL, fileKey = "types.ts", base }) => {
    const yamlNullable = contract.prop(schemaName, field).nullable === true;
    const declared = model.prop(fileKey, iface, field);
    const where = `${sourceFile}: ${iface}.${field}`;
    const yamlWhere = `openapi.yaml: components.schemas.${schemaName}.${field}`;

    if (declared.ifaceMissing) {
      add(group, `${sourceFile}: no interface \`${iface}\` for ${yamlWhere} — the contract block needs a declared type`);
      return;
    }
    if (declared.missing) {
      add(group, `${where} is not declared — ${yamlWhere} is ${yamlNullable ? `${base} | null` : base}`);
      return;
    }
    const typedAsExpected = base === "number" ? declared.isNumber : declared.isString;
    if (!typedAsExpected) {
      add(
        group,
        `${where} is \`${declared.typeText}\` — ${yamlWhere} is ${yamlNullable ? `${base} | null` : base}`,
      );
      return;
    }
    if (yamlNullable && !declared.hasNull) {
      add(group, `${where} is \`${declared.typeText}\` — ${yamlWhere} is \`nullable: true\`, declare \`${base} | null\``);
    }
    if (!yamlNullable && declared.hasNull) {
      add(
        group,
        `${where} is \`${declared.typeText}\` — ${yamlWhere} is NOT nullable, drop \`null\` (dado ausente só é null onde o contrato diz null)`,
      );
    }
  };

  /** Exact literal set on both sides, in both directions. */
  const literalSet = (group, schemaName, field, { iface = interfaceFor(schemaName), sourceFile = TYPES_LABEL, fileKey = "types.ts" } = {}) => {
    const expected = contract.enumOf(schemaName, field);
    const declared = model.prop(fileKey, iface, field);
    const where = `${sourceFile}: ${iface}.${field}`;
    const yamlWhere = `openapi.yaml: components.schemas.${schemaName}.properties.${field}.enum`;
    const expectedText = `${expected.length} literals [${sortedList(expected)}]`;

    if (declared.ifaceMissing) {
      add(group, `${sourceFile}: no interface \`${iface}\` for ${yamlWhere} — the contract block needs a declared type`);
      return;
    }
    if (declared.missing) {
      add(group, `${where} is not declared — ${yamlWhere} is ${expectedText}`);
      return;
    }
    if (declared.literals.length === 0) {
      add(group, `${where} is \`${declared.typeText}\` with no literals — ${yamlWhere} is ${expectedText}`);
      return;
    }
    const missing = expected.filter((value) => !declared.literals.includes(value));
    const extra = declared.literals.filter((value) => !expected.includes(value));
    if (missing.length > 0) {
      add(group, `${where} is missing ${sortedList(missing)} — ${yamlWhere} has [${sortedList(expected)}]`);
    }
    if (extra.length > 0) {
      add(group, `${where} accepts ${sortedList(extra)}, which ${yamlWhere} does not have [${sortedList(expected)}]`);
    }
  };

  // [1] openapi.yaml › components.schemas.SkillSummary.source_url (nullable)
  nullability(1, "SkillSummary", "source_url", { base: "string" });

  // [2] openapi.yaml › components.schemas.SkillSummary.category (nullable)
  nullability(2, "SkillSummary", "category", { base: "string" });

  // [3] openapi.yaml › components.schemas.LlmInfo.status (7 literals)
  literalSet(3, "LlmInfo", "status");
  {
    const alias = model.aliasFacts("LlmStatus");
    const expected = contract.enumOf("LlmInfo", "status");
    if (alias && alias.literals.length > 0) {
      const missing = expected.filter((value) => !alias.literals.includes(value));
      const extra = alias.literals.filter((value) => !expected.includes(value));
      if (missing.length > 0) {
        add(3, `${TYPES_LABEL}: LlmStatus is missing ${sortedList(missing)} — openapi.yaml: components.schemas.LlmInfo.properties.status.enum has [${sortedList(expected)}]`);
      }
      if (extra.length > 0) {
        add(3, `${TYPES_LABEL}: LlmStatus accepts ${sortedList(extra)}, which openapi.yaml: components.schemas.LlmInfo.properties.status.enum does not have`);
      }
    }
  }

  // [4] openapi.yaml › ScoreBreakdown: the three factors are plain numbers (no null)
  for (const factor of ["stars", "vulnerabilities", "installs"]) {
    nullability(4, "ScoreBreakdown", factor, { base: "number" });
  }

  // [5] openapi.yaml › ResultItem.caveats: required and `string | null`
  {
    const required = contract.required("ResultItem");
    const yamlNullable = contract.prop("ResultItem", "caveats").nullable === true;
    if (!required.includes("caveats")) {
      throw new ContractError("openapi.yaml: components.schemas.ResultItem.required does not list `caveats` — refusing to pass green by omission");
    }
    if (!yamlNullable) {
      throw new ContractError("openapi.yaml: components.schemas.ResultItem.properties.caveats is no longer `nullable: true` — refusing to pass green with a stale expectation");
    }
    nullability(5, "ResultItem", "caveats", { base: "string" });
  }

  // [6] openapi.yaml › SkillSummary.security_status (exactly 4 literals)
  literalSet(6, "SkillSummary", "security_status");
  {
    const alias = model.aliasFacts("SecurityStatus");
    const expected = contract.enumOf("SkillSummary", "security_status");
    if (alias && alias.literals.length > 0) {
      const missing = expected.filter((value) => !alias.literals.includes(value));
      const extra = alias.literals.filter((value) => !expected.includes(value));
      if (missing.length > 0) {
        add(6, `${TYPES_LABEL}: SecurityStatus is missing ${sortedList(missing)} — openapi.yaml: components.schemas.SkillSummary.properties.security_status.enum has [${sortedList(expected)}]`);
      }
      if (extra.length > 0) {
        add(6, `${TYPES_LABEL}: SecurityStatus accepts ${sortedList(extra)}, which openapi.yaml: components.schemas.SkillSummary.properties.security_status.enum does not have`);
      }
    }
  }

  // [7] openapi.yaml › LlmInfo.model (nullable)
  nullability(7, "LlmInfo", "model", { base: "string" });

  // [8] openapi.yaml › SkillDetailResponse { request_id, data } + api.ts::getSkill
  {
    const required = contract.required("SkillDetailResponse");
    if (!required.includes("request_id") || !required.includes("data")) {
      throw new ContractError(
        "openapi.yaml: components.schemas.SkillDetailResponse.required must list `request_id` and `data` — refusing to pass green by omission",
      );
    }
    const dataRef = contract.prop("SkillDetailResponse", "data");
    if (dataRef.$ref !== "#/components/schemas/SkillDetail") {
      throw new ContractError(
        `openapi.yaml: components.schemas.SkillDetailResponse.properties.data is "${String(dataRef.$ref)}", expected "#/components/schemas/SkillDetail"`,
      );
    }
    const okRef = contract.responseSchema("/api/v1/skills/{skill_id}", "get", "200")?.content?.["application/json"]
      ?.schema?.$ref;
    if (okRef !== "#/components/schemas/SkillDetailResponse") {
      throw new ContractError(
        `openapi.yaml: paths./api/v1/skills/{skill_id}.get.responses.200 returns "${String(okRef)}", expected "#/components/schemas/SkillDetailResponse" — refusing to pass green by omission`,
      );
    }
    const declared = model.prop("types.ts", "SkillDetailResponse", "data");
    const requestId = model.prop("types.ts", "SkillDetailResponse", "request_id");
    if (declared.ifaceMissing) {
      add(8, `${TYPES_LABEL}: SkillDetailResponse is not declared — openapi.yaml: components.schemas.SkillDetailResponse is { request_id: string, data: SkillDetail } (required)`);
    } else if (declared.missing) {
      add(8, `${TYPES_LABEL}: SkillDetailResponse.data is not declared — openapi.yaml: components.schemas.SkillDetailResponse.properties.data is SkillDetail`);
    } else if (declared.typeText !== "SkillDetail") {
      add(8, `${TYPES_LABEL}: SkillDetailResponse.data is \`${declared.typeText}\` — openapi.yaml: components.schemas.SkillDetailResponse.properties.data is \`SkillDetail\``);
    }
    if (!declared.ifaceMissing && requestId.missing) {
      add(8, `${TYPES_LABEL}: SkillDetailResponse.request_id is not declared — openapi.yaml: components.schemas.SkillDetailResponse.required lists it`);
    }
    const skill = model.returnOf("api.ts", "getSkill");
    if (skill.missing) {
      add(8, `${API_LABEL}: getSkill is not exported — openapi.yaml: paths./api/v1/skills/{skill_id}.get returns SkillDetailResponse`);
    } else if (skill.typeText !== "Promise<SkillDetailResponse>" && skill.annotationText !== "Promise<SkillDetailResponse>") {
      add(
        8,
        `${API_LABEL}: getSkill returns \`${skill.typeText ?? skill.annotationText}\` — openapi.yaml: paths./api/v1/skills/{skill_id}.get 200 returns \`SkillDetailResponse\` ({ request_id, data }); do not unwrap the envelope`,
      );
    }
  }

  // [9] openapi.yaml › /api/v1/skills sort_by enum (installs | stars | name)
  {
    const param = contract.queryParam("/api/v1/skills", "get", "sort_by");
    const expected = Array.isArray(param.schema?.enum) ? param.schema.enum.map(String) : null;
    if (!expected) {
      throw new ContractError(
        "openapi.yaml: paths./api/v1/skills.get parameters.sort_by has no enum — refusing to pass green by omission",
      );
    }
    const declared = model.prop("api.ts", "SkillListParams", "sortBy");
    const where = `${API_LABEL}: SkillListParams.sortBy`;
    const yamlWhere = "openapi.yaml: paths./api/v1/skills.get parameters.sort_by.schema.enum";
    if (declared.ifaceMissing) {
      add(9, `${API_LABEL}: interface SkillListParams is not declared — ${yamlWhere} is [${sortedList(expected)}]`);
    } else if (declared.missing) {
      add(9, `${where} is not declared — ${yamlWhere} is [${sortedList(expected)}]`);
    } else if (declared.literals.length === 0) {
      add(9, `${where} is \`${declared.typeText}\` with no literals — ${yamlWhere} is [${sortedList(expected)}]`);
    } else {
      const missing = expected.filter((value) => !declared.literals.includes(value));
      const extra = declared.literals.filter((value) => !expected.includes(value));
      if (missing.length > 0) {
        add(9, `${where} is missing ${sortedList(missing)} — ${yamlWhere} has [${sortedList(expected)}]`);
      }
      if (extra.length > 0) {
        add(9, `${where} accepts ${sortedList(extra)}, which ${yamlWhere} does not have [${sortedList(expected)}]`);
      }
    }
  }

  // [10] snapshot fields are NOT nullable in the contract
  nullability(10, "SearchData", "catalog_snapshot", { base: "string" });
  nullability(10, "SearchData", "age_seconds", { base: "number" });
  nullability(10, "CategoryListResponse", "data_snapshot", { base: "string" });

  // [11] openapi.yaml › ErrorEnvelope.request_id (nullable)
  nullability(11, "ErrorEnvelope", "request_id", { base: "string" });

  // [12] client hygiene: no mocks, no x-internal routes in the API client
  {
    const forbidden = [
      { token: "MOCK_", reason: "mock data must not live in the API client" },
      { token: "loadMock", reason: "mock loaders must not live in the API client" },
      { token: "/admin", reason: "x-internal (admin) endpoints do not belong in the browser client" },
      { token: "/metrics", reason: "x-internal (metrics) is scraped by Prometheus, not by the browser" },
      { token: "/healthz", reason: "x-internal (liveness) is a probe, not a client route" },
      { token: "/readyz", reason: "x-internal (readiness) is a probe, not a client route" },
    ];
    const lines = apiText.split(/\r?\n/);
    for (const { token, reason } of forbidden) {
      const hits = [];
      lines.forEach((line, index) => {
        if (line.includes(token)) hits.push(index + 1);
      });
      if (hits.length === 0) continue;
      const shown = hits.slice(0, 8).join(", ") + (hits.length > 8 ? ", …" : "");
      add(
        12,
        `${API_LABEL}: \`${token}\` appears on ${hits.length === 1 ? "line" : "lines"} ${shown} — ${reason}; the contract exposes ${endpointSummary}`,
      );
    }
  }

  // [13] openapi.yaml › SearchRequest.category (nullable) + the limits the UI mirrors
  nullability(13, "SearchRequest", "category", { base: "string" });
  {
    const query = contract.prop("SearchRequest", "query");
    const limit = contract.prop("SearchRequest", "limit");
    const comparisons = [
      ["QUERY_MIN_LENGTH", query.minLength, "components.schemas.SearchRequest.properties.query.minLength"],
      ["QUERY_MAX_LENGTH", query.maxLength, "components.schemas.SearchRequest.properties.query.maxLength"],
      ["SEARCH_LIMIT_MAX", limit.maximum, "components.schemas.SearchRequest.properties.limit.maximum"],
    ];
    for (const [name, expected, yamlWhere] of comparisons) {
      if (typeof expected !== "number") {
        throw new ContractError(`openapi.yaml: ${yamlWhere} is not a number — refusing to pass green by omission`);
      }
      const declared = model.constValue(name);
      if (declared.missing) {
        add(13, `${TYPES_LABEL}: ${name} is not exported — openapi.yaml: ${yamlWhere} is ${expected}`);
      } else if (declared.nonLiteral !== undefined) {
        add(13, `${TYPES_LABEL}: ${name} is not a literal (${declared.nonLiteral}) — openapi.yaml: ${yamlWhere} is ${expected}`);
      } else if (declared.value !== expected) {
        add(13, `${TYPES_LABEL}: ${name} is ${declared.value} — openapi.yaml: ${yamlWhere} is ${expected}`);
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(
    [
      "usage: node frontend/scripts/check-contract.mjs [--openapi <file>] [--frontend <dir>]",
      "",
      "  --openapi  contract file (default: <repo>/openapi.yaml)",
      "  --frontend frontend directory holding tsconfig.json + src (default: <repo>/frontend)",
      "",
      "exit 0 = contract and declared types agree; 1 = divergence or missing contract block.",
      "",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const openapiText = readFileSync(args.openapi, "utf8");
  const contract = buildContract(openapiText);
  const model = buildModel(args.frontend);
  const apiText = readFileSync(path.join(args.frontend, "src", "api.ts"), "utf8");

  const failures = runChecks({ contract, model, apiText });

  const header = [
    "contract guard — openapi.yaml ↔ frontend/src (issue #24)",
    `  contract: ${rel(args.openapi)}`,
    `  types:    ${rel(path.join(args.frontend, "src", "types.ts"))}`,
    `  client:   ${rel(path.join(args.frontend, "src", "api.ts"))}`,
    `  parsed:   ${Object.keys(contract.paths).length} endpoints, ${Object.keys(contract.schemas).length} schemas`,
    "",
  ].join("\n");
  process.stdout.write(`${header}\n`);

  if (failures.length === 0) {
    process.stdout.write(
      `✓ contract matches: 13 groups checked, ${Object.keys(contract.paths).length} endpoints, ${Object.keys(contract.schemas).length} schemas\n`,
    );
    return 0;
  }

  process.stdout.write(
    `✗ contract guard failed — ${failures.length} divergence(s) between openapi.yaml and frontend/src\n\n`,
  );
  const byGroup = new Map();
  for (const failure of failures) {
    if (!byGroup.has(failure.group)) byGroup.set(failure.group, []);
    byGroup.get(failure.group).push(failure.message);
  }
  for (const group of [...byGroup.keys()].sort((a, b) => a - b)) {
    for (const message of byGroup.get(group)) {
      process.stdout.write(`  [${group}] ${message}\n`);
    }
  }
  process.stdout.write("\nfix the declaration in frontend/src, never the expectations of the guard\n");
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof ContractError) {
    process.stderr.write(`✗ contract guard aborted: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
