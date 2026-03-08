import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";

const DEFAULT_MAX_ENTRIES = 300;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_CONTEXT_FILES = 4;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  "coverage",
  ".idea",
  ".vscode",
]);

const PRIORITY_NAMES = [
  "README.md",
  "README",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "Cargo.toml",
  "src",
  "src-tauri",
  "app",
  "components",
  "pages",
  "services",
  "stores",
];

const DEFAULT_CONTEXT_CANDIDATES = [
  "README.md",
  "README",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "src/main.tsx",
  "src/App.tsx",
  "src/index.tsx",
  "src-tauri/Cargo.toml",
  "src-tauri/src/main.rs",
];

export interface WorkspaceFileContext {
  path: string;
  content: string;
}

export interface WorkspaceContextBundle {
  tree?: string;
  files: WorkspaceFileContext[];
}

function isTauriEnv(): boolean {
  return !!window.__TAURI_INTERNALS__;
}

export async function pickWorkspaceDir(): Promise<string | null> {
  if (!isTauriEnv()) return null;
  const dir = await open({ directory: true, multiple: false });
  return typeof dir === "string" ? dir : null;
}

export function getWorkspaceName(workspaceDir: string | undefined | null): string {
  if (!workspaceDir) return "";
  const parts = workspaceDir.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || workspaceDir;
}

function shouldIgnoreName(name: string): boolean {
  if (!name) return true;
  if (name.startsWith(".")) return true;
  return IGNORED_DIRS.has(name);
}

function compareEntries(a: { name?: string }, b: { name?: string }): number {
  const aName = a.name ?? "";
  const bName = b.name ?? "";
  const aPriority = PRIORITY_NAMES.findIndex((n) => n === aName);
  const bPriority = PRIORITY_NAMES.findIndex((n) => n === bName);
  const aRank = aPriority === -1 ? 999 : aPriority;
  const bRank = bPriority === -1 ? 999 : bPriority;
  if (aRank !== bRank) return aRank - bRank;
  return aName.localeCompare(bName);
}

function joinPath(base: string, name: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[/\\]+$/, "")}${sep}${name}`;
}

function getRelativePath(root: string, fullPath: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedFull = fullPath.replace(/\\/g, "/");
  return normalizedFull.startsWith(normalizedRoot + "/")
    ? normalizedFull.slice(normalizedRoot.length + 1)
    : normalizedFull;
}

export function sanitizeRelativePath(relativePath: string): string | null {
  let p = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = p.split("/").filter((part) => part && part !== "." && part !== "..");
  if (parts.length === 0) return null;
  if (parts.some((part) => shouldIgnoreName(part))) return null;
  return parts.join("/");
}

export async function readWorkspaceTree(
  workspaceDir: string,
  options?: { maxEntries?: number; maxDepth?: number },
): Promise<string> {
  if (!isTauriEnv() || !workspaceDir) return "";

  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const lines: string[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number) {
    if (lines.length >= maxEntries || depth > maxDepth) {
      truncated = true;
      return;
    }

    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }

    const filtered = entries.filter((entry) => !shouldIgnoreName(entry.name ?? ""));
    filtered.sort(compareEntries);

    for (const entry of filtered) {
      if (lines.length >= maxEntries) {
        truncated = true;
        return;
      }
      const name = entry.name ?? "";
      const fullPath = joinPath(dir, name);
      const relativePath = getRelativePath(workspaceDir, fullPath);
      const indent = "  ".repeat(depth);
      lines.push(`${indent}${entry.isDirectory ? "📁" : "📄"} ${relativePath}${entry.isDirectory ? "/" : ""}`);
      if (entry.isDirectory && depth + 1 < maxDepth) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(workspaceDir, 0);
  if (truncated) lines.push("… (workspace tree truncated)");
  return lines.join("\n");
}

export async function readWorkspaceFile(
  workspaceDir: string,
  relativePath: string,
  options?: { maxBytes?: number },
): Promise<string> {
  if (!isTauriEnv() || !workspaceDir) return "";
  const safePath = sanitizeRelativePath(relativePath);
  if (!safePath) throw new Error("Invalid file path");

  const fullPath = joinPath(workspaceDir, safePath);
  const text = await readTextFile(fullPath);
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (new Blob([text]).size > maxBytes) {
    throw new Error(`File too large (> ${Math.round(maxBytes / 1024)}KB)`);
  }
  return text;
}

async function tryReadWorkspaceFile(
  workspaceDir: string,
  relativePath: string,
): Promise<WorkspaceFileContext | null> {
  try {
    const safePath = sanitizeRelativePath(relativePath);
    if (!safePath) return null;
    const content = await readWorkspaceFile(workspaceDir, safePath);
    return { path: safePath, content };
  } catch {
    return null;
  }
}

function extractPathsFromText(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    const safe = sanitizeRelativePath(match);
    if (safe) unique.add(safe);
  }
  return [...unique];
}

function shouldIncludeDefaultContext(text: string): boolean {
  return /项目|project|code review|review|架构|结构|代码|仓库|repo|看看|分析|analy[sz]e/i.test(text);
}

export async function buildWorkspaceContextBundle(
  workspaceDir: string,
  userText: string,
  options?: { includeTree?: boolean; maxFiles?: number },
): Promise<WorkspaceContextBundle> {
  if (!workspaceDir || !isTauriEnv()) return { files: [] };

  const includeTree = options?.includeTree ?? true;
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_CONTEXT_FILES;
  const requestedPaths = extractPathsFromText(userText);
  const candidatePaths = [...requestedPaths];

  if (shouldIncludeDefaultContext(userText)) {
    for (const path of DEFAULT_CONTEXT_CANDIDATES) candidatePaths.push(path);
  }

  const uniqueCandidates = [...new Set(candidatePaths)];
  const files: WorkspaceFileContext[] = [];

  for (const path of uniqueCandidates) {
    if (files.length >= maxFiles) break;
    const file = await tryReadWorkspaceFile(workspaceDir, path);
    if (file) files.push(file);
  }

  const tree = includeTree ? await readWorkspaceTree(workspaceDir).catch(() => "") : "";
  return {
    tree: tree || undefined,
    files,
  };
}
