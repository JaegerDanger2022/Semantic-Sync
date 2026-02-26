import * as vscode from 'vscode';

/**
 * Reads .gitignore lines from the workspace root.
 * Returns null if no .gitignore file exists.
 */
export async function readGitignore(rootUri: vscode.Uri): Promise<string[] | null> {
  const gitignoreUri = vscode.Uri.joinPath(rootUri, '.gitignore');
  try {
    const bytes = await vscode.workspace.fs.readFile(gitignoreUri);
    const text = Buffer.from(bytes).toString('utf8');
    return text.split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * Builds an ignore matcher from .gitignore lines.
 * Returns a function that takes a relative path (forward slashes) and returns true if it should be ignored.
 */
export function buildIgnoreMatcher(lines: string[]): (relativePath: string) => boolean {
  const rules = parseRules(lines);
  return (relativePath: string) => {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    return isIgnored(normalized, rules);
  };
}

type Rule = {
  pattern: string;
  negated: boolean;
  anchored: boolean; // leading slash — anchored to root
  dirOnly: boolean;  // trailing slash — match directories only
  regex: RegExp;
};

function parseRules(lines: string[]): Rule[] {
  const rules: Rule[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    // Skip comments and blank lines
    if (!line || line.startsWith('#')) {
      continue;
    }
    let pattern = line;
    const negated = pattern.startsWith('!');
    if (negated) {
      pattern = pattern.slice(1);
    }
    // A leading backslash escapes a leading # or !
    if (pattern.startsWith('\\')) {
      pattern = pattern.slice(1);
    }
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) {
      pattern = pattern.slice(0, -1);
    }
    const anchored = pattern.includes('/') && !pattern.startsWith('**/');
    // Remove leading slash for anchored patterns
    const cleanPattern = pattern.startsWith('/') ? pattern.slice(1) : pattern;

    try {
      const regex = gitignorePatternToRegex(cleanPattern, anchored);
      rules.push({ pattern: cleanPattern, negated, anchored, dirOnly, regex });
    } catch {
      // Skip malformed patterns
    }
  }
  return rules;
}

function gitignorePatternToRegex(pattern: string, anchored: boolean): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // **/ matches zero or more directories
        regexStr += '(?:.+/)?';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        regexStr += '\\[';
        i++;
      } else {
        regexStr += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      regexStr += escapeRegex(ch);
      i++;
    }
  }

  if (anchored) {
    // Must match from root
    return new RegExp(`^${regexStr}(?:/.*)?$`);
  } else {
    // Can match any path component
    return new RegExp(`(?:^|/)${regexStr}(?:/.*)?$`);
  }
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function isIgnored(relativePath: string, rules: Rule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(relativePath)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

export const DEFAULT_GITIGNORE_CONTENT = `# Dependencies
node_modules/

# Git
.git/

# Build outputs
dist/
build/
out/
.next/

# Environment
.env
.env.local
.env.*.local

# Logs
*.log
npm-debug.log*
`;
