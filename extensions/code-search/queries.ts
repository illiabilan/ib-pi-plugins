/**
 * Tree-sitter symbol queries per language.
 *
 * Each query captures symbol declarations with a capture name matching
 * the symbol type we want to report (function, class, interface, type,
 * enum, method, variable, const, property, import).
 */

export interface LanguageConfig {
  /** Grammar name inside the tree-sitter-wasms package (out/tree-sitter-<name>.wasm) */
  wasm: string;
  /** File extensions handled by this language (without dot) */
  extensions: string[];
  /** Tree-sitter query used to extract symbols */
  query: string;
}

export const LANGUAGES: Record<string, LanguageConfig> = {
  typescript: {
    wasm: "typescript",
    extensions: ["ts", "mts", "cts"],
    query: `
      (function_declaration name: (identifier) @function)
      (function_signature name: (identifier) @function)
      (method_definition name: (property_identifier) @method)
      (method_signature name: (property_identifier) @method)
      (class_declaration name: (type_identifier) @class)
      (abstract_class_declaration name: (type_identifier) @class)
      (interface_declaration name: (type_identifier) @interface)
      (type_alias_declaration name: (type_identifier) @type)
      (enum_declaration name: (identifier) @enum)
      (variable_declarator name: (identifier) @function value: (arrow_function))
      (variable_declarator name: (identifier) @function value: (function_expression))
      (variable_declarator name: (identifier) @variable)
      (public_field_definition name: (property_identifier) @property)
    `,
  },
  tsx: {
    wasm: "tsx",
    extensions: ["tsx"],
    query: `
      (function_declaration name: (identifier) @function)
      (function_signature name: (identifier) @function)
      (method_definition name: (property_identifier) @method)
      (method_signature name: (property_identifier) @method)
      (class_declaration name: (type_identifier) @class)
      (abstract_class_declaration name: (type_identifier) @class)
      (interface_declaration name: (type_identifier) @interface)
      (type_alias_declaration name: (type_identifier) @type)
      (enum_declaration name: (identifier) @enum)
      (variable_declarator name: (identifier) @function value: (arrow_function))
      (variable_declarator name: (identifier) @function value: (function_expression))
      (variable_declarator name: (identifier) @variable)
      (public_field_definition name: (property_identifier) @property)
    `,
  },
  javascript: {
    wasm: "javascript",
    extensions: ["js", "mjs", "cjs", "jsx"],
    query: `
      (function_declaration name: (identifier) @function)
      (method_definition name: (property_identifier) @method)
      (class_declaration name: (identifier) @class)
      (variable_declarator name: (identifier) @function value: (arrow_function))
      (variable_declarator name: (identifier) @function value: (function_expression))
      (variable_declarator name: (identifier) @variable)
      (field_definition property: (property_identifier) @property)
    `,
  },
  python: {
    wasm: "python",
    extensions: ["py", "pyi"],
    query: `
      (function_definition name: (identifier) @function)
      (class_definition name: (identifier) @class)
      (assignment left: (identifier) @variable)
    `,
  },
  rust: {
    wasm: "rust",
    extensions: ["rs"],
    query: `
      (function_item name: (identifier) @function)
      (struct_item name: (type_identifier) @class)
      (trait_item name: (type_identifier) @interface)
      (enum_item name: (type_identifier) @enum)
      (const_item name: (identifier) @const)
      (static_item name: (identifier) @variable)
      (type_item name: (type_identifier) @type)
    `,
  },
  go: {
    wasm: "go",
    extensions: ["go"],
    query: `
      (function_declaration name: (identifier) @function)
      (method_declaration name: (field_identifier) @method)
      (type_spec name: (type_identifier) @type)
      (var_spec name: (identifier) @variable)
      (const_spec name: (identifier) @const)
    `,
  },
  java: {
    wasm: "java",
    extensions: ["java"],
    query: `
      (method_declaration name: (identifier) @method)
      (constructor_declaration name: (identifier) @method)
      (class_declaration name: (identifier) @class)
      (interface_declaration name: (identifier) @interface)
      (enum_declaration name: (identifier) @enum)
      (field_declaration declarator: (variable_declarator name: (identifier) @property))
    `,
  },
  cpp: {
    wasm: "cpp",
    extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
    query: `
      (function_definition declarator: (function_declarator declarator: (identifier) @function))
      (function_definition declarator: (function_declarator declarator: (field_identifier) @method))
      (class_specifier name: (type_identifier) @class)
      (struct_specifier name: (type_identifier) @class)
      (enum_specifier name: (type_identifier) @enum)
    `,
  },
  c: {
    wasm: "c",
    extensions: ["c", "h"],
    query: `
      (function_definition declarator: (function_declarator declarator: (identifier) @function))
      (struct_specifier name: (type_identifier) @class)
      (enum_specifier name: (type_identifier) @enum)
    `,
  },
  ruby: {
    wasm: "ruby",
    extensions: ["rb"],
    query: `
      (method name: (identifier) @method)
      (singleton_method name: (identifier) @method)
      (class name: (constant) @class)
      (module name: (constant) @class)
    `,
  },
  php: {
    wasm: "php",
    extensions: ["php"],
    query: `
      (function_definition name: (name) @function)
      (method_declaration name: (name) @method)
      (class_declaration name: (name) @class)
      (interface_declaration name: (name) @interface)
    `,
  },
  kotlin: {
    wasm: "kotlin",
    extensions: ["kt", "kts"],
    // The Kotlin grammar represents classes, interfaces, enums, and objects
    // all as variants of `class_declaration` / `object_declaration`, keyed
    // by anonymous keyword tokens rather than distinct node types. More
    // specific patterns (interface, enum) are listed before the generic
    // `class` pattern; the caller dedupes overlapping matches by position
    // and keeps the first (most specific) one.
    query: `
      (class_declaration "interface" (type_identifier) @interface)
      (class_declaration "enum" "class" (type_identifier) @enum)
      (class_declaration "class" (type_identifier) @class)
      (object_declaration (type_identifier) @class)
      (function_declaration (simple_identifier) @function)
      (property_declaration (variable_declaration (simple_identifier) @variable))
    `,
  },
};

/** Map a file extension (no dot) to a language key in LANGUAGES */
export function languageForExtension(ext: string): string | null {
  const lower = ext.toLowerCase();
  for (const [key, config] of Object.entries(LANGUAGES)) {
    if (config.extensions.includes(lower)) return key;
  }
  return null;
}

/** All glob patterns for supported extensions, e.g. ["**\/*.ts", "**\/*.tsx", ...] */
export function allGlobPatterns(): string[] {
  const exts = new Set<string>();
  for (const config of Object.values(LANGUAGES)) {
    for (const ext of config.extensions) exts.add(ext);
  }
  return Array.from(exts).map((ext) => `**/*.${ext}`);
}
