// 프로젝트 타입
export type ProjectType = 'cpo' | 'groupware' | 'hmg-board';

// 배포 종류 타입
export type DeployType = 'release' | 'adhoc' | 'hotfix';

// 프로젝트별 MR 링크 필드 설정
export interface MRFieldConfig {
  id: string;
  label: string;
  placeholder: string;
}

// 폼 데이터 타입
export interface DeployFormData {
  project: ProjectType | null;
  deployType: DeployType | null;
  deployDocLink: string;
  mrLinks: Record<string, string>;
}

// 프로젝트 옵션 타입
export interface ProjectOption {
  value: ProjectType;
  label: string;
}

// 배포 종류 옵션 타입
export interface DeployTypeOption {
  value: DeployType;
  label: string;
}
