import type {
  ProjectType,
  ProjectOption,
  DeployTypeOption,
  MRFieldConfig,
} from './types';

// 프로젝트 옵션 목록
export const PROJECT_OPTIONS: ProjectOption[] = [
  { value: 'cpo', label: 'CPO' },
  { value: 'groupware', label: '그룹웨어' },
  { value: 'hmg-board', label: 'HMG Board' },
];

// 배포 종류 옵션 목록
export const DEPLOY_TYPE_OPTIONS: DeployTypeOption[] = [
  { value: 'release', label: 'Release (정기배포)' },
  { value: 'adhoc', label: 'Adhoc (임시배포)' },
  { value: 'hotfix', label: 'Hotfix (긴급수정)' },
];

// 배포 종류별 표시 텍스트 (템플릿용)
export const DEPLOY_TYPE_DISPLAY: Record<
  string,
  { title: string; branch: string }
> = {
  release: { title: '정기배포', branch: 'release' },
  adhoc: { title: '임시배포', branch: 'adhoc' },
  hotfix: { title: '핫픽스', branch: 'hotfix' },
};

// 프로젝트별 MR 링크 필드 설정
export const MR_FIELDS_BY_PROJECT: Record<ProjectType, MRFieldConfig[]> = {
  cpo: [
    {
      id: 'bo',
      label: 'BO MR 링크',
      placeholder:
        'https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-bo-web/-/merge_requests/...',
    },
    {
      id: 'pricing',
      label: '프라이싱 MR 링크',
      placeholder:
        'https://gitlab.hmc.co.kr/kia-cpo/kia-pricing-bo-web/-/merge_requests/...',
    },
    {
      id: 'evaluator',
      label: '평가사 MR 링크',
      placeholder:
        'https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-partner-web/-/merge_requests/...',
    },
  ],
  groupware: [
    {
      id: 'main',
      label: 'MR 링크',
      placeholder: 'https://gitlab.hmc.co.kr/.../merge_requests/...',
    },
  ],
  'hmg-board': [
    {
      id: 'main',
      label: 'MR 링크',
      placeholder: 'https://gitlab.hmc.co.kr/.../merge_requests/...',
    },
  ],
};

// 초기 폼 데이터
export const INITIAL_FORM_DATA = {
  project: null,
  deployType: null,
  deployDocLink: '',
  mrLinks: {},
};
