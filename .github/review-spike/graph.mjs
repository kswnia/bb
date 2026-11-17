import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const [headDirectory, baseSha, headSha, prNumber] = process.argv.slice(2);
if (!headDirectory || !/^[a-f0-9]{40}$/.test(baseSha ?? "") || !/^[a-f0-9]{40}$/.test(headSha ?? "") || !/^\d+$/.test(prNumber ?? "")) {
  throw new Error("Expected head directory, base SHA, head SHA, and PR number");
}

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runGit = (...args) => execFileSync("git", args, { cwd: repositoryDirectory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const changedFiles = runGit("diff", "--name-only", baseSha, headSha, "--", "*.ts", "*.tsx").trim().split("\n").filter(Boolean);
if (changedFiles.length > 40) throw new Error("This spike supports at most 40 changed TypeScript files");

const trackedFiles = execFileSync("git", ["ls-files", "--cached", "--", "*.ts", "*.tsx"], {
  cwd: headDirectory,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
}).trim().split("\n").filter(Boolean);
const trackedFileSet = new Set(trackedFiles);
const changedFunctions = [];

for (const file of changedFiles) {
  if (!trackedFileSet.has(file)) continue;
  const source = readFileSync(path.join(headDirectory, file), "utf8");
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const diff = runGit("diff", "--unified=0", baseSha, headSha, "--", file);
  const changedLines = new Set();
  let newLine = 0;
  for (const row of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (hunk) {
      newLine = Number(hunk[1]);
    } else if (row.startsWith("+") && !row.startsWith("+++")) {
      changedLines.add(newLine++);
    }
  }
  for (const statement of syntax.statements) {
    let name;
    let body;
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      name = statement.name.text;
      body = statement.body;
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          const start = syntax.getLineAndCharacterOfPosition(declaration.getStart(syntax)).line + 1;
          const end = syntax.getLineAndCharacterOfPosition(declaration.end).line + 1;
          if ([...changedLines].some((line) => line >= start && line <= end)) {
            changedFunctions.push({ file, name: declaration.name.text, line: start });
          }
        }
      }
    }
    if (name && body) {
      const start = syntax.getLineAndCharacterOfPosition(statement.getStart(syntax)).line + 1;
      const end = syntax.getLineAndCharacterOfPosition(statement.end).line + 1;
      if ([...changedLines].some((line) => line >= start && line <= end)) changedFunctions.push({ file, name, line: start });
    }
  }
}

const callers = [];
for (const file of trackedFiles) {
  const source = readFileSync(path.join(headDirectory, file), "utf8");
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = new Map();
  for (const statement of syntax.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    const stem = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.replace(/\.(?:js|mjs|ts|tsx)$/u, "")));
    const target = [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`].find((candidate) => trackedFileSet.has(candidate));
    if (!target || !statement.importClause?.namedBindings) continue;
    const bindings = statement.importClause.namedBindings;
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) imports.set(element.name.text, { target, name: element.propertyName?.text ?? element.name.text });
    } else if (ts.isNamespaceImport(bindings)) {
      imports.set(bindings.name.text, { target, namespace: true });
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      let imported;
      if (ts.isIdentifier(node.expression)) imported = imports.get(node.expression.text);
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
        const namespace = imports.get(node.expression.expression.text);
        if (namespace?.namespace) imported = { target: namespace.target, name: node.expression.name.text };
      }
      const changed = changedFunctions.find((item) => imported?.target === item.file && imported?.name === item.name);
      if (changed) {
        const line = syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1;
        callers.push({ changed, file, line });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
}

const context = { repository: "get-bb/bb", prNumber: Number(prNumber), baseSha, headSha, changedFunctions, callers };
const outputDirectory = path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(outputDirectory, "graph-context.json"), JSON.stringify(context, null, 2));
const report = [
  `# BB call graph: upstream PR #${prNumber}`,
  "",
  `Head: \`${headSha}\``,
  "",
  `Found ${changedFunctions.length} changed top-level functions and ${callers.length} direct call sites.`,
  "",
  "This is a partial static graph. It follows direct relative imports; it misses package aliases, re-exports, methods, dynamic calls, and type-only changes.",
  "",
];
for (const call of callers) {
  report.push(`- [${call.file}:${call.line}](https://github.com/get-bb/bb/blob/${headSha}/${call.file}#L${call.line}) calls [${call.changed.file}:${call.changed.line} ${call.changed.name}](https://github.com/get-bb/bb/blob/${headSha}/${call.changed.file}#L${call.changed.line})`);
}
if (!callers.length) report.push("No supported call sites found for this PR. This does not prove there are no callers.");
writeFileSync(path.join(outputDirectory, "call-graph.md"), report.join("\n") + "\n");
