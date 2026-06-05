export interface PRComment {
  id: number;
  node_id: string;
  in_reply_to_id?: number;
  line: number;
  body: string;
  user: { login: string; avatar_url: string; name?: string };
  created_at: string;
  outdated?: boolean;
}

export interface ThreadMeta {
  nodeId: string;
  isResolved: boolean;
  rootCommentId: number;
  path: string;
}

export interface OpenPR {
  number: number;
  title: string;
  branch: string;
  headSha: string;
  author: string;
  updatedAt: string;
}

export interface PRFileInfo {
  markdownFiles: string[];
  validLinesByPath: Map<string, number[]>;
}
