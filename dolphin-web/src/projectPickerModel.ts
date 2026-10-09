import type { WorkspaceDirectory, WorkspaceRoot } from './types';

export interface PickerNode {
  path: string;
  name: string;
  isRoot: boolean;
  isProject: boolean;
  exists: boolean;
  /* react-arborist reads children through childrenAccessor: null means leaf,
     while [] means expandable but not yet loaded. A directory that starts as
     null renders with no expand arrow, so has_children decides which it is. */
  children: PickerNode[] | null;
  childrenLoaded: boolean;
}

export function rootNodes(roots: readonly WorkspaceRoot[]): PickerNode[] {
  return roots.map((root) => ({
    path: root.path,
    name: root.path,
    isRoot: true,
    isProject: false,
    exists: root.exists,
    children: [],
    childrenLoaded: false,
  }));
}

export function directoryNodes(
  directories: readonly WorkspaceDirectory[],
): PickerNode[] {
  return directories.map((directory) => ({
    path: directory.path,
    name: directory.name,
    isRoot: false,
    isProject: directory.is_project,
    exists: true,
    children: directory.has_children ? [] : null,
    childrenLoaded: false,
  }));
}

export function insertChildren(
  nodes: PickerNode[],
  path: string,
  children: PickerNode[],
): PickerNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.path === path) {
      changed = true;
      return { ...node, children, childrenLoaded: true };
    }
    if (!node.children || node.children.length === 0) return node;
    const nested = insertChildren(node.children, path, children);
    if (nested === node.children) return node;
    changed = true;
    return { ...node, children: nested };
  });
  return changed ? next : nodes;
}

function isUnder(path: string, root: string): boolean {
  /* The trailing separator matters: without it "/home/user-backup" reads as
     living under "/home/user". */
  return path === root || path.startsWith(`${root}/`);
}

export interface ResultGroup {
  root: WorkspaceRoot;
  results: WorkspaceDirectory[];
}

export function groupResultsByRoot(
  results: readonly WorkspaceDirectory[],
  roots: readonly WorkspaceRoot[],
): ResultGroup[] {
  return roots
    .map((root) => ({
      root,
      results: results.filter((result) => isUnder(result.path, root.path)),
    }))
    .filter((group) => group.results.length > 0);
}
