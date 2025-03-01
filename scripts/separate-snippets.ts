// [SNIPPET_REGISTRY disabled]

import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

// Regex for comment which must be included in a file for it to be separated
const RE_SNIPPETS_SEPARATION = /\[SNIPPETS_SEPARATION\s+enabled\]/;

// Regex for comment to control the separator suffix
const RE_SNIPPETS_SUFFIX = /\[SNIPPETS_SUFFIX\s+([A-Za-z0-9_]+)\]/;

// Regex for [START] and [END] snippet tags.
const RE_START_SNIPPET = /\[START\s+([A-Za-z_]+)\s*\]/;
const RE_END_SNIPPET = /\[END\s+([A-Za-z_]+)\s*\]/;

// Regex for const = require statements
// TODO: Handle multiline imports?
const RE_REQUIRE = /const {(.+?)} = require\((.+?)\)/;

type SnippetsConfig = {
  enabled: boolean;
  suffix: string;
  map: Record<string, string[]>;
};

const DEFAULT_SUFFIX = "_modular";

function isBlank(line: string) {
  return line.trim().length === 0;
}

/**
 * Replace all const { foo } = require('bar') with import { foo } from 'bar';
 */
function replaceRequireWithImport(lines: string[]) {
  const outputLines = [];
  for (const line of lines) {
    if (line.match(RE_REQUIRE)) {
      outputLines.push(line.replace(RE_REQUIRE, `import {$1} from $2`));
    } else {
      outputLines.push(line);
    }
  }
  return outputLines;
}

/**
 * Change all [START foo] and [END foo] to be [START foosuffix] and [END foosuffix]
 */
function addSuffixToSnippetNames(lines: string[], snippetSuffix: string) {
  const outputLines = [];
  for (const line of lines) {
    if (line.match(RE_START_SNIPPET)) {
      outputLines.push(line.replace(RE_START_SNIPPET, `[START $1${snippetSuffix}]`));
    } else if (line.match(RE_END_SNIPPET)) {
      outputLines.push(
        line.replace(RE_END_SNIPPET, `[END $1${snippetSuffix}]`)
      );
    } else {
      outputLines.push(line);
    }
  }
  return outputLines;
}

/**
 * Remove all left-padding so that the least indented line is left-aligned.
 */
function adjustIndentation(lines: string[]) {
  const nonBlankLines = lines.filter((l) => !isBlank(l));
  const indentSizes = nonBlankLines.map((l) => l.length - l.trimLeft().length);
  const minIndent = Math.min(...indentSizes);

  const outputLines = [];
  for (const line of lines) {
    if (isBlank(line)) {
      outputLines.push("");
    } else {
      outputLines.push(line.substr(minIndent));
    }
  }
  return outputLines;
}

/**
 * If the first line after leading comments is blank, remove it.
 */
function removeFirstLineAfterComments(lines: string[]) {
  const outputLines = [...lines];

  const firstNonComment = outputLines.findIndex(
    (l) => !l.startsWith("//")
  );
  if (firstNonComment >= 0 && isBlank(outputLines[firstNonComment])) {
    outputLines.splice(firstNonComment, 1);
  }

  return outputLines;
}

/**
 * Turns a series of source lines into a standalone snippet file by running
 * a series of transformations.
 *
 * @param lines the lines containing the snippet (including START/END comments)
 * @param sourceFile the source file where the original snippet lives (used in preamble)
 * @param snippetSuffix the suffix (such as _modular)
 */
function processSnippet(
  lines: string[],
  sourceFile: string,
  snippetSuffix: string
): string {
  let outputLines = [...lines];

  // Perform transformations individually, in order
  outputLines = replaceRequireWithImport(outputLines);
  outputLines = addSuffixToSnippetNames(outputLines, snippetSuffix);
  outputLines = adjustIndentation(outputLines);
  outputLines = removeFirstLineAfterComments(outputLines);

  // Add a preamble to every snippet
  const preambleLines = [
    `// This snippet file was generated by processing the source file:`,
    `// ${sourceFile}`,
    `//`,
    `// To update the snippets in this file, edit the source and then run`,
    `// 'npm run snippets'.`,
    ``,
  ];
  const content = [...preambleLines, ...outputLines].join("\n");
  return content;
}

/**
 * Lists all the files in this repository that should be checked for snippets
 */
function listSnippetFiles(): string[] {
  const output = cp
    .execSync(
      'find . -type f -name "*.js" -not -path "*node_modules*" -not -path "./snippets*"'
    )
    .toString();
  return output.split("\n").filter((x) => !isBlank(x));
}

/**
 * Collect all the snippets from a file into a map of snippet name to lines.
 * @param filePath the file path to read.
 */
function collectSnippets(filePath: string): SnippetsConfig {
  const fileContents = fs.readFileSync(filePath).toString();
  const lines = fileContents.split("\n");

  const config: SnippetsConfig = {
    enabled: false,
    suffix: DEFAULT_SUFFIX,
    map: {},
  };

  // If a file does not have '// [SNIPPETS_SEPARATION enabled]' in it then 
  // we don't process it for this script.
  config.enabled = lines.some((l) => !!l.match(RE_SNIPPETS_SEPARATION));
  if (!config.enabled) {
    return config;
  }

  // If the file contains '// [SNIPPETS_SUFFIX _banana]' we use _banana (or whatever)
  // as the suffix. Otherwise we default to _modular.
  const suffixLine = lines.find((l) => !!l.match(RE_SNIPPETS_SUFFIX));
  if (suffixLine) {
    const m = suffixLine.match(RE_SNIPPETS_SUFFIX);
    config.suffix = m[1];
  }

  // A temporary array holding the names of snippets we're currently within.
  // This allows for handling nested snippets.
  let inSnippetNames = [];

  for (const line of lines) {
    const startMatch = line.match(RE_START_SNIPPET);
    const endMatch = line.match(RE_END_SNIPPET);

    if (startMatch) {
      // When we find a new [START foo] tag we are now inside snippet 'foo'.
      // Until we find an [END foo] tag. All lines we see between now and then
      // are part of the snippet content.
      const snippetName = startMatch[1];
      if (config.map[snippetName] !== undefined) {
        throw new Error(`Detected more than one snippet with the tag ${snippetName}!`);
      }

      config.map[snippetName] = [line];
      inSnippetNames.push(snippetName);
    } else if (endMatch) {
      // When we find a new [END foo] tag we are now exiting snippet 'foo'.
      const snippetName = endMatch[1];

      // If we were not aware that we were inside this snippet (no previous START)
      // then we hard throw.
      if (!inSnippetNames.includes(snippetName)) {
        throw new Error(
          `Unrecognized END tag ${snippetName} in ${filePath}.`
        );
      }

      // Collect this line as the final line of the snippet and then
      // remove this snippet name from the list we're tracking.
      config.map[snippetName].push(line);
      inSnippetNames.splice(inSnippetNames.indexOf(snippetName), 1);
    } else if (inSnippetNames.length > 0) {
      // Any line that is not START or END is appended to the list of
      // lines for all the snippets we're currently tracking.
      for (const snippetName of inSnippetNames) {
        config.map[snippetName].push(line);
      }
    }
  }

  return config;
}

async function main() {
  const fileNames = listSnippetFiles();

  for (const filePath of fileNames) {
    const config = collectSnippets(filePath);
    if (!config.enabled) {
      continue;
    }

    const fileSlug = filePath
      .replace(".js", "")
      .replace("./", "")
      .replace(/\./g, "-");
    const snippetDir = path.join("./snippets", fileSlug);

    console.log(
      `Processing: ${filePath} --> ${snippetDir} (suffix=${config.suffix})`
    );

    if (!fs.existsSync(snippetDir)) {
      fs.mkdirSync(snippetDir, { recursive: true });
    }

    for (const snippetName in config.map) {
      const newFilePath = path.join(snippetDir, `${snippetName}.js`);

      const snippetLines = config.map[snippetName];
      const content = processSnippet(
        snippetLines,
        filePath,
        config.suffix
      );

      fs.writeFileSync(newFilePath, content);
    }
  }
}

main();
