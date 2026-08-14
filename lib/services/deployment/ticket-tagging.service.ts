/**
 * 배포 태그 적용 서비스
 * 티켓에 배포 관련 fixVersion과 labels를 설정
 */

import axios from 'axios';
import https from 'https';
import { JIRA_ENDPOINTS } from '@/lib/constants/jira';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export interface ApplyDeploymentTagsRequest {
  /** 티켓 키 목록 (예: ['AUTOWAY-2636']) */
  ticketKeys: string[];
  /** 설정할 fixVersion 이름 (예: 'release_260226') */
  fixVersion?: string;
  /** 추가할 레이블 목록 (예: ['QA필요', 'FE']) - 배포 관련이 아닌 일반 labels */
  labels?: string[];
}

export interface ApplyDeploymentTagsResponse {
  success: boolean;
  /** 성공한 티켓 목록 */
  successTickets?: string[];
  /** 실패한 티켓 목록 */
  failedTickets?: Array<{
    ticketKey: string;
    error: string;
  }>;
  /** 에러 메시지 */
  error?: string;
}

/**
 * 티켓에 fixVersion과 labels 설정
 * fixVersion을 설정하고, 기존 labels를 유지하면서 새 labels를 추가합니다.
 */
export async function applyDeploymentTags(
  request: ApplyDeploymentTagsRequest
): Promise<ApplyDeploymentTagsResponse> {
  const email = process.env.HMG_JIRA_EMAIL;
  const apiToken = process.env.HMG_JIRA_API_TOKEN;

  if (!email || !apiToken) {
    return {
      success: false,
      error: 'HMG Jira 인증 정보가 설정되지 않았습니다.',
    };
  }

  try {
    const { ticketKeys, fixVersion, labels } = request;

    // fixVersion과 labels가 모두 없으면 에러
    if (!fixVersion && (!labels || labels.length === 0)) {
      return {
        success: false,
        error: 'fixVersion 또는 labels 중 하나는 필수입니다.',
      };
    }

    const successTickets: string[] = [];
    const failedTickets: Array<{ ticketKey: string; error: string }> = [];

    // fixVersion이 있으면 프로젝트에서 버전 목록 조회하여 ID 확인
    // (Jira API는 name으로도 가능하지만, ID가 더 안정적)
    let fixVersionId: string | undefined;
    if (fixVersion) {
      try {
        // 첫 번째 티켓의 프로젝트 키 추출 (모든 티켓이 같은 프로젝트라고 가정)
        const projectKey = ticketKeys[0]?.split('-')[0];
        if (projectKey) {
          const versionsResponse = await axios.get(
            `${JIRA_ENDPOINTS.HMG}/rest/api/3/project/${projectKey}/versions`,
            {
              auth: {
                username: email,
                password: apiToken,
              },
              headers: {
                Accept: 'application/json',
              },
              httpsAgent,
            }
          );

          const versions = versionsResponse.data as Array<{
            id: string;
            name: string;
          }>;
          const foundVersion = versions.find((v) => v.name === fixVersion);
          if (foundVersion) {
            fixVersionId = foundVersion.id;
          } else {
            // 버전이 존재하지 않으면 새로 생성
            try {
              // 프로젝트 정보 조회 (projectId 필요)
              const projectResponse = await axios.get(
                `${JIRA_ENDPOINTS.HMG}/rest/api/3/project/${projectKey}`,
                {
                  auth: {
                    username: email,
                    password: apiToken,
                  },
                  headers: {
                    Accept: 'application/json',
                  },
                  httpsAgent,
                }
              );

              const projectId = projectResponse.data.id;

              // fixVersion 이름에서 날짜 추출 (예: release_260202 -> 2026-02-02)
              // 형식: {type}_{YYMMDD} -> 20{YY}-{MM}-{DD}
              let releaseDate: string | undefined;
              const dateMatch = fixVersion.match(/_(\d{6})$/);
              if (dateMatch) {
                const dateStr = dateMatch[1]; // YYMMDD
                const year = `20${dateStr.substring(0, 2)}`;
                const month = dateStr.substring(2, 4);
                const day = dateStr.substring(4, 6);
                releaseDate = `${year}-${month}-${day}`;
              }

              // 새 버전 생성
              const createVersionResponse = await axios.post(
                `${JIRA_ENDPOINTS.HMG}/rest/api/3/version`,
                {
                  projectId,
                  name: fixVersion,
                  ...(releaseDate && { releaseDate }),
                  released: false,
                  archived: false,
                },
                {
                  auth: {
                    username: email,
                    password: apiToken,
                  },
                  headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                  },
                  httpsAgent,
                }
              );

              fixVersionId = createVersionResponse.data.id;
              console.log(`새 버전 생성됨: ${fixVersion} (ID: ${fixVersionId})`);
            } catch (createError) {
              console.error('버전 생성 실패:', createError);
              if (axios.isAxiosError(createError)) {
                const errorData = createError.response?.data;
                return {
                  success: false,
                  error: `버전 생성 실패: ${errorData?.errorMessages?.[0] || errorData?.message || createError.message}`,
                };
              }
              return {
                success: false,
                error: `버전 생성 실패: ${createError instanceof Error ? createError.message : String(createError)}`,
              };
            }
          }
        }
      } catch (error) {
        console.error('프로젝트 버전 조회 실패:', error);
        // 버전 조회 실패해도 계속 진행 (name으로 시도)
      }
    }

    // 각 티켓에 대해 순차 처리
    for (const ticketKey of ticketKeys) {
      let updateFields: Record<string, unknown> | undefined;
      try {
        // 1. 티켓 정보 조회 (기존 fixVersion과 labels 확인)
        const getResponse = await axios.get(
          `${JIRA_ENDPOINTS.HMG}/rest/api/3/issue/${ticketKey}`,
          {
            params: {
              fields: 'fixVersions,labels',
            },
            auth: {
              username: email,
              password: apiToken,
            },
            headers: {
              Accept: 'application/json',
            },
            httpsAgent,
          }
        );

        const fields = getResponse.data.fields;
        const existingFixVersions = (fields.fixVersions || []) as Array<{
          id: string;
          name: string;
        }>;
        const existingLabels = (fields.labels || []) as string[];

        // 2. fixVersion 설정
        // fixVersion이 제공되면, 기존 fixVersion에 추가 (중복 제거)
        let newFixVersions: Array<{ id: string } | { name: string }> = [];
        if (fixVersion) {
          // 기존 fixVersions를 업데이트 형식으로 변환 (id만 사용)
          const existingForUpdate = existingFixVersions.map((fv) => ({ id: fv.id }));
          
          // 이미 같은 fixVersion이 있는지 확인
          const hasFixVersion = existingFixVersions.some(
            (fv) => fv.name === fixVersion || fv.id === fixVersionId
          );
          
          if (!hasFixVersion) {
            // ID가 있으면 ID 사용, 없으면 name 사용
            if (fixVersionId) {
              newFixVersions = [...existingForUpdate, { id: fixVersionId }];
            } else {
              // 기존 버전들은 id로, 새 버전은 name으로
              newFixVersions = [...existingForUpdate, { name: fixVersion }];
            }
          } else {
            // 이미 있으면 기존 것만 유지
            newFixVersions = existingForUpdate;
          }
        } else {
          // fixVersion이 없으면 기존 것만 유지
          newFixVersions = existingFixVersions.map((fv) => ({ id: fv.id }));
        }

        // 3. labels 병합 (중복 제거)
        let newLabels = existingLabels;
        if (labels && labels.length > 0) {
          newLabels = Array.from(new Set([...existingLabels, ...labels]));
        }

        // 4. 티켓 업데이트
        updateFields = {};
        if (fixVersion) {
          // Jira API는 fixVersions (복수형) 필드를 사용
          updateFields.fixVersions = newFixVersions;
        }
        if (labels && labels.length > 0) {
          updateFields.labels = newLabels;
        }

        await axios.put(
          `${JIRA_ENDPOINTS.HMG}/rest/api/3/issue/${ticketKey}`,
          {
            fields: updateFields,
          },
          {
            auth: {
              username: email,
              password: apiToken,
            },
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            httpsAgent,
          }
        );

        successTickets.push(ticketKey);
      } catch (error) {
        if (axios.isAxiosError(error)) {
          // 상세 에러 정보 추출
          const errorData = error.response?.data;
          const errorMessage =
            errorData?.errorMessages?.[0] ||
            errorData?.errors?.fixVersions ||
            errorData?.message ||
            error.message;
          
          // 응답 데이터 전체를 로깅 (디버깅용)
          console.error(`티켓 ${ticketKey} 업데이트 실패:`, {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: errorData,
            fixVersion,
            updateFields,
          });
          
          failedTickets.push({
            ticketKey,
            error: errorMessage || `Request failed with status code ${error.response?.status || 400}`,
          });
        } else {
          failedTickets.push({
            ticketKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // 결과 반환
    if (failedTickets.length === 0) {
      return {
        success: true,
        successTickets,
      };
    } else if (successTickets.length > 0) {
      // 일부 성공, 일부 실패
      return {
        success: true,
        successTickets,
        failedTickets,
      };
    } else {
      // 모두 실패
      return {
        success: false,
        error: '모든 티켓에 태그 적용이 실패했습니다.',
        failedTickets,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
