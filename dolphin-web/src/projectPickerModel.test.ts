import { describe, expect, it } from 'vitest';

import {
  directoryNodes,
  groupResultsByRoot,
  insertChildren,
  rootNodes,
} from './projectPickerModel';
import type { WorkspaceDirectory, WorkspaceRoot } from './types';

const ROOTS: WorkspaceRoot[] = [
  { path: '/home/user', name: 'home', exists: true },
  { path: '/srv/work', name: 'data', exists: true },
];

function directory(path: string, overrides: Partial<WorkspaceDirectory> = {}): WorkspaceDirectory {
  return {
    name: path.split('/').pop() ?? path,
    path,
    is_project: false,
    has_children: false,
    ...overrides,
  };
}

describe('rootNodes', () => {
  it('renders each root as an expandable node keyed by its path', () => {
    const nodes = rootNodes(ROOTS);
    expect(nodes.map((node) => node.path)).toEqual(['/home/user', '/srv/work']);
    expect(nodes.every((node) => node.isRoot)).toBe(true);
    // Expandable, not leaf, and not yet loaded.
    expect(nodes[0].children).toEqual([]);
    expect(nodes[0].childrenLoaded).toBe(false);
  });

  it('keeps a missing root visible so it can be reported', () => {
    const nodes = rootNodes([{ path: '/srv/work', name: 'data', exists: false }]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].exists).toBe(false);
  });
});

describe('directoryNodes', () => {
  it('marks a directory with no children as a leaf', () => {
    const [node] = directoryNodes([directory('/home/user/leaf')]);
    expect(node.children).toBeNull();
  });

  it('marks a directory with children as expandable but unloaded', () => {
    const [node] = directoryNodes([directory('/home/user/deep', { has_children: true })]);
    expect(node.children).toEqual([]);
    expect(node.childrenLoaded).toBe(false);
  });

  it('carries the project flag through', () => {
    const [node] = directoryNodes([directory('/home/user/repo', { is_project: true })]);
    expect(node.isProject).toBe(true);
  });
});

describe('insertChildren', () => {
  it('attaches children to a nested node without mutating the input', () => {
    const nodes = rootNodes(ROOTS);
    const frozen = JSON.stringify(nodes);

    const next = insertChildren(nodes, '/home/user', directoryNodes([directory('/home/user/projects', { has_children: true })]));

    expect(JSON.stringify(nodes)).toBe(frozen);
    expect(next[0].children?.map((child) => child.path)).toEqual(['/home/user/projects']);
    expect(next[0].childrenLoaded).toBe(true);
  });

  it('reaches a node several levels down', () => {
    let nodes = rootNodes(ROOTS);
    nodes = insertChildren(nodes, '/home/user', directoryNodes([directory('/home/user/projects', { has_children: true })]));
    nodes = insertChildren(nodes, '/home/user/projects', directoryNodes([directory('/home/user/projects/dolphin')]));

    expect(nodes[0].children?.[0].children?.[0].path).toBe('/home/user/projects/dolphin');
  });

  it('returns the tree unchanged when the path is not present', () => {
    const nodes = rootNodes(ROOTS);
    expect(insertChildren(nodes, '/nowhere', [])).toEqual(nodes);
  });

  it('does not mutate untouched subtrees when inserting several levels down', () => {
    let before = rootNodes(ROOTS);
    before = insertChildren(
      before,
      '/home/user',
      directoryNodes([
        directory('/home/user/projects', { has_children: true }),
        directory('/home/user/other'),
      ]),
    );
    before = insertChildren(
      before,
      '/home/user/projects',
      directoryNodes([
        directory('/home/user/projects/dolphin', { has_children: true }),
        directory('/home/user/projects/sibling'),
      ]),
    );
    const frozen = JSON.stringify(before);

    const next = insertChildren(
      before,
      '/home/user/projects/dolphin',
      directoryNodes([directory('/home/user/projects/dolphin/deep')]),
    );

    // The original tree, at every depth, is structurally untouched.
    expect(JSON.stringify(before)).toBe(frozen);

    // Untouched subtrees keep their exact object identity all the way down --
    // the point of copy-on-write is the sharing, and a JSON snapshot can't
    // see a deep clone that would pass the check above while destroying it.
    expect(next[1]).toBe(before[1]); // /srv/work: untouched root sibling
    expect(next[0].children?.[1]).toBe(before[0].children?.[1]); // /home/user/other
    expect(next[0].children?.[0].children?.[1]).toBe(
      before[0].children?.[0].children?.[1],
    ); // /home/user/projects/sibling

    // The insertion itself landed on the right node.
    expect(
      next[0].children?.[0].children?.[0].children?.map((child) => child.path),
    ).toEqual(['/home/user/projects/dolphin/deep']);
  });
});

describe('groupResultsByRoot', () => {
  it('files each result under the root that contains it', () => {
    const groups = groupResultsByRoot(
      [directory('/srv/work/projects/runner'), directory('/home/user/projects/alpha')],
      ROOTS,
    );

    expect(groups.map((group) => group.root.path)).toEqual(['/home/user', '/srv/work']);
    expect(groups[0].results.map((item) => item.path)).toEqual(['/home/user/projects/alpha']);
  });

  it('omits a root with no matches rather than showing an empty group', () => {
    const groups = groupResultsByRoot([directory('/home/user/projects/alpha')], ROOTS);
    expect(groups).toHaveLength(1);
  });

  it('does not mistake a sibling with a shared prefix for a child', () => {
    const groups = groupResultsByRoot([directory('/home/user-backup/x')], ROOTS);
    expect(groups).toHaveLength(0);
  });
});
