export interface TargetProjectConfig {
  projectId: string;
  syncProfileId: string | null;
}

export interface Team {
  id: string;
  name: string;
  createdAt: string;
  sourceProjectId: string | null;
  leaderId: string | null;
  targets: TargetProjectConfig[];
  memberIds: string[];
}
